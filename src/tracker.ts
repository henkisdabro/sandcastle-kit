// Where a project's tickets live. The orchestrator talks to a `Tracker`; each
// adapter here is one system:
//
//   github  GitHub Issues through `gh` (the default, and what every project
//           did before trackers existed).
//   files   Markdown tickets in the repo, in the layout Matt Pocock's
//           `/setup-matt-pocock-skills` calls "Local Markdown":
//           .scratch/<feature>/issues/<NN>-<slug>.md with a `Status:` line,
//           `Blocked by: NN, NN`, and comments under `## Comments`.
//
// Which one a project uses: `tracker` in .sandcastle/config.ts if set;
// otherwise what docs/agents/issue-tracker.md says (written by Matt's setup
// skill, which a project is free never to have run); otherwise GitHub.
//
// A ticket id is a string that is safe in a branch and file name: "12" for
// GitHub, "checkout-03" for .scratch/checkout/issues/03-*.md.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { OperatorError } from "./errors.ts";
import { sh } from "./sandbox.ts";

export type Ticket = { id: string; title: string; body: string; comments: string[]; updated?: number; status?: string; labels?: string[] };
export type TicketState = Ticket & { open: boolean; held: boolean };

export type TrackerConfig = "github" | "files" | { type: "github" } | { type: "files"; dir?: string; done?: string[] };

export interface Tracker {
  readonly kind: "github" | "files";
  /** How a person names a ticket: "#12", "checkout-03". */
  ref(id: string): string;
  /** Open tickets carrying the queue label / status. Comments cost a larger fetch; skip them when unused. */
  queued(withComments?: boolean): Ticket[];
  /** Every open ticket, queued or not. */
  open(withComments?: boolean): Ticket[];
  /** One ticket now, for `TICKETS=` and the check just before landing. */
  get(id: string): TicketState;
  /** Extra prompt arguments for a ticket (the ticket text, when the sandbox cannot fetch it). */
  promptArgs(id: string): Record<string, string>;
  /** `agents` write their own comments (GitHub); otherwise the orchestrator posts their report. */
  readonly agentsWrite: boolean;
  comment(id: string, text: string): void;
  /** Done: a closing comment, and out of the queue. */
  close(id: string, text: string): void;
  /** Out of the queue and marked for a human, with the reason. */
  hold(id: string, text: string): void;
  /** Back in the queue: the queue label (GitHub) or status (files) on, the hold off, the note (if any) as a comment first. */
  requeue(id: string, note?: string): void;
  /** State, labels, comment count and a title/body hash (GitHub also keys LATEST_ISSUE), to prove a dry run wrote nothing. */
  snapshot(ids: string[]): Map<string, string>;
  /** Whether the ticket was reopened / requeued by someone after `at` (ms). */
  reopenedSince(id: string, at: number): boolean;
  /** Blockers a ticket declares besides "Blocked by ..." in its body. */
  declaredBlockers(id: string): string[];
  /** Whether a ticket id is closed, for a blocker on this same tracker. */
  isClosed(id: string): boolean | undefined;
  /** What a dry run tells agents not to touch. */
  readonly dryRunNote: string;
  /** Prompt wording that differs by tracker; fills the prompts' {{KIT_<NAME>}}. */
  readonly words: Record<"LOST" | "TICKET_VIEW" | "COMMENTS_VIEW" | "NEW_TICKET" | "NEW_TICKET_REVIEW" | "RECORD" | "NOCHANGE" | "BLOCKED" | "SAY", string>;
}

/** The snapshot key for the GitHub repo's highest issue number: a new issue moves it. Not a ticket id. */
export const LATEST_ISSUE = "latest issue";

export const isNumeric = (id: string) => /^\d+$/.test(id);
export const refOf = (id: string) => (isNumeric(id) ? `#${id}` : id);

// The kit's hold label before it took Matt Pocock's `ready-for-human`. Still read as held, so a
// ticket a person marked with it before an upgrade is not taken by the next run.
const OLD_HELD = "needs-human";
// Without case: GitHub labels ignore it, and a ticket file's status is read lowercased.
const isHeld = (project: Project, name?: string) => !!name && [project.tracker.held.toLowerCase(), OLD_HELD].includes(name.toLowerCase());

// A fence one backtick longer than any run inside, so ticket text cannot close it.
const fence = (text: string) => {
  const f = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${f}markdown\n${text}\n${f}`;
};

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

// `gh issue list` stops at this many and does not say so.
const LIST_LIMIT = 500;

/**
 * Makes sure the triage label (`needs-triage` unless the repo maps it) exists,
 * so agents can put it on the follow-up issues they file. Created here, on the
 * host with its own `gh` login: the sandbox token can add a label but not
 * create one. No --force, so a label a person already made keeps its colour and
 * description. A failure only costs the label, never the run.
 */
export const ensureTriageLabel = (label: string, gh = (args: string[]) => sh("gh", args)) => {
  try {
    // `gh label list --search` prints nothing at all, not `[]`, when no label matches.
    const found = JSON.parse(gh(["label", "list", "--search", label, "--json", "name", "--limit", "100"]) || "[]") as { name: string }[];
    if (found.some((l) => l.name === label)) return;
    gh(["label", "create", label, "--color", "FBCA04", "--description", "Filed by a sandcastle agent; triage before queueing"]);
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);
    console.log(`  warning: could not create the ${label} label: ${why}; agent-filed tickets will be unlabelled`);
  }
};

const github = (project: Project): Tracker => {
  // A failed gh call is the operator's to act on (signed out, no such issue, no network): its own
  // first stderr line, not a stack trace. Callers that match a message (`already exists`) still can.
  const gh = (args: string[]) => {
    try {
      return sh("gh", args);
    } catch (e) {
      const err = e as { stderr?: unknown; message?: string };
      const why = (String(err.stderr ?? "").trim() || String(err.message)).split("\n")[0].slice(0, 200);
      // gh's own words name no way out: a Go dial error, or a signed-out token.
      const fix = /no git remotes found|none of the git remotes .* point to a known GitHub host/i.test(why)
        ? ` - this repository has no GitHub remote, so the github tracker has no GitHub issues to read. Add one (\`git remote add origin <url>\`), or keep tickets in files: \`tracker: "files"\` in .sandcastle/config.ts.`
        : /dial tcp|connection refused|no such host|i\/o timeout|proxyconnect|error connecting|TLS handshake|network is unreachable/i.test(why)
        ? " - GitHub could not be reached. Check the network (or proxy), then try again."
        : /HTTP 401|bad credentials|gh auth login|authentication/i.test(why)
        ? " - gh is not signed in to GitHub: `gh auth status` says why, `gh auth login` signs it in."
        : /Could not resolve to an? /i.test(why)
        ? ""
        : " - `sandcastle doctor` checks gh's sign-in and the GitHub remote.";
      throw new OperatorError(`gh ${args.slice(0, 2).join(" ")} failed: ${why}${fix}`);
    }
  };
  const list = (extra: string[], withComments: boolean): Ticket[] => {
    const listed = JSON.parse(gh(["issue", "list", "--state", "open", ...extra, "--limit", String(LIST_LIMIT), "--json", `number,title,body,updatedAt,labels${withComments ? ",comments" : ""}`])) as any[];
    // Counted before the hold-label filter below: a full page is full whatever
    // is dropped from it. stderr, because `queue --json` is parsed from stdout.
    if (listed.length === LIST_LIMIT) {
      const label = extra[extra.indexOf("--label") + 1];
      console.warn(`gh returned the limit of ${LIST_LIMIT} open tickets${extra.includes("--label") ? ` labelled ${label}` : ""}; any beyond it are not seen.`);
    }
    return listed
      // A person who adds the hold label to a queued issue by hand leaves the
      // queue label on (hold() takes it off). Listed, it came back every run
      // only to be withdrawn unstarted; it is a human's until they requeue it.
      .filter((i) => !extra.includes("--label") || !i.labels.some((l: { name: string }) => isHeld(project, l.name)))
      .map((i) => ({
      id: String(i.number),
      title: i.title,
      body: i.body ?? "",
      comments: (i.comments ?? []).map((c: { body: string }) => c.body),
      updated: i.updatedAt ? Math.floor(Date.parse(i.updatedAt) / 1000) : undefined,
      labels: (i.labels ?? []).map((l: { name: string }) => l.name),
    }));
  };
  return {
    kind: "github",
    agentsWrite: true,
    ref: refOf,
    // The queue label stands in for a status: the check before landing then
    // sees a ticket taken out of the queue mid-run, as it does for ticket files.
    queued: (withComments = true) => list(["--label", project.label], withComments).map((t) => ({ ...t, status: project.label })),
    open: (withComments = true) => list([], withComments),
    get: (id) => {
      const i = JSON.parse(gh(["issue", "view", id, "--json", "number,title,state,body,comments,labels"]));
      return {
        id: String(i.number),
        title: i.title,
        body: i.body ?? "",
        comments: i.comments.map((c: { body: string }) => c.body),
        labels: (i.labels ?? []).map((l: { name: string }) => l.name),
        open: i.state === "OPEN",
        held: i.labels.some((l: { name: string }) => isHeld(project, l.name)),
        status: i.labels.some((l: { name: string }) => l.name === project.label) ? project.label : undefined,
      };
    },
    // The sandbox reads the live issue itself, with the token it already holds.
    promptArgs: () => ({}),
    comment: (id, text) => void gh(["issue", "comment", id, "--body", text]),
    close: (id, text) => {
      // Close before unlabelling: a run that dies between the two leaves a
      // closed issue with a stale label (harmless - the queue lists open
      // issues only), where the other order left an open, unlabelled, merged
      // issue that no later run would ever list again.
      gh(["issue", "close", id, "--comment", text]);
      // Closed is what counts: a failed unlabel here was reported as a failed
      // close, and "the next run closes it" - of an issue already closed.
      try {
        gh(["issue", "edit", id, "--remove-label", project.label]);
      } catch {
        /* a stale label on a closed issue is harmless */
      }
    },
    hold: (id, text) => {
      // No --force: it resets the colour and description of a label the repo
      // already has. Only "already exists" is expected; any other failure
      // (permissions, network) still stops the hold.
      try {
        gh(["label", "create", project.tracker.held, "--color", "D93F0B"]);
      } catch (e) {
        if (!/already exists/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
      gh(["issue", "edit", id, "--remove-label", project.label, "--add-label", project.tracker.held]);
      gh(["issue", "comment", id, "--body", text]);
    },
    requeue: (id, note) => {
      // The note first: a run that picks the ticket up straight away already sees it.
      if (note) gh(["issue", "comment", id, "--body", note]);
      // --remove-label only for a hold label on the issue: a repo that has
      // never had that label makes gh fail on it.
      const held = (JSON.parse(gh(["issue", "view", id, "--json", "labels"])).labels as { name: string }[]).filter((l) => isHeld(project, l.name));
      gh(["issue", "edit", id, "--add-label", project.label, ...held.flatMap((l) => ["--remove-label", l.name])]);
    },
    snapshot: (ids) => {
      const seen = new Map(
        ids.map((n) => {
          try {
            const i = JSON.parse(gh(["issue", "view", n, "--json", "state,labels,comments,title,body"]));
            // A hash, not the text: an edited title or body changes the entry
            // without a whole issue body landing in the breach line.
            const text = createHash("sha256").update(`${i.title}\n${i.body ?? ""}`).digest("hex").slice(0, 12);
            return [n, `${i.state} [${i.labels.map((l: { name: string }) => l.name).sort().join(",")}] ${i.comments.length} comment(s) text ${text}`];
          } catch {
            return [n, "unreadable"];
          }
        }),
      );
      // The highest issue number, newest first: a `gh issue create` by an agent
      // is in no run ticket's snapshot, but it moves this.
      try {
        const [latest] = JSON.parse(gh(["issue", "list", "--state", "all", "--limit", "1", "--json", "number"])) as { number: number }[];
        seen.set(LATEST_ISSUE, latest ? `#${latest.number}` : "none");
      } catch {
        seen.set(LATEST_ISSUE, "unreadable");
      }
      return seen;
    },
    // A reopen changes the issue after the merge. On an error, assume it was
    // reopened: the run then does the work normally instead of closing an
    // issue that may want more.
    reopenedSince: (id, at) => {
      try {
        const events = gh(["api", "--paginate", `repos/{owner}/{repo}/issues/${id}/events`, "--jq", '.[] | select(.event == "reopened") | .created_at']);
        return events.split("\n").some((t) => t && Date.parse(t) > at);
      } catch {
        return true;
      }
    },
    declaredBlockers: () => [],
    isClosed: () => undefined,
    words: {
      LOST: "comment on the ticket that the sandbox's git record was lost",
      TICKET_VIEW: "!`gh issue view {{ISSUE_NUMBER}}`",
      COMMENTS_VIEW: "# Comments on the ticket\n\n!`gh issue view {{ISSUE_NUMBER}} --comments`\n\n",
      NEW_TICKET: `GitHub issue (\`gh issue create --label ${project.tracker.triage}\`; if that label is refused, create it without the label)`,
      NEW_TICKET_REVIEW: `open a new GitHub issue\n  (\`gh issue create --label ${project.tracker.triage}\`; if that label is refused, create it without the label)`,
      RECORD:
        "**Before you finish, comment on the ticket** with what you changed, the commit(s), and anything a\n" +
        "human must still do. The ticket is closed automatically when your branch merges, so that comment is\n" +
        "the record.",
      NOCHANGE: "Comment on the ticket with the evidence.",
      BLOCKED:
        "Comment on ticket {{TICKET}} explaining what you\nlearned and what a human must decide, then add the labels:\n\n" +
        `\`\`\`\ngh label create ${project.tracker.held} --color D93F0B 2>/dev/null || true\ngh issue edit {{ISSUE_NUMBER}} --add-label ${project.tracker.held} --remove-label {{KIT_LABEL}}\n\`\`\``,
      SAY: "in a comment on the ticket",
    },
    dryRunNote:
      "**This is a dry run.** Write nothing to GitHub: do not comment on, open, close or label any ticket " +
      "(`gh issue comment`, `gh issue create`, `gh issue close`, `gh issue edit`, `gh label`). Wherever these " +
      "instructions say to do one of those, put what you would have posted in your final message instead, under " +
      "\"Would post:\". Reading tickets with `gh` is fine. Everything else - the work, the commits, the gates - is " +
      "exactly as in a real run.\n\n",
  };
};

// ---------------------------------------------------------------------------
// Local Markdown files
// ---------------------------------------------------------------------------

export const DEFAULT_DONE = ["done", "closed", "resolved", "wontfix"];

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// One "Key: value" line: "Status: x" or "**Status:** x". Not a bullet: a list item
// under the title is prose.
const META = /^\**([A-Za-z][A-Za-z ]*?)\**[ \t]*:\**[ \t]*(.*?)[ \t]*$/;
const clean = (v: string) => v.replace(/^[`"'*]+|[`"'*]+$/g, "").trim();

/**
 * A ticket's metadata: the consecutive "Key: value" lines under its title (and
 * YAML front matter, if any). Only that block counts, so a "Status:" in the
 * prose below is prose. Matt Pocock's layout puts `Status:` and `Blocked by:`
 * here.
 */
export const headerOf = (text: string) => {
  const lines = text.split("\n");
  const meta = new Map<string, { value: string; index: number }>();
  let i = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) {
      for (let j = 1; j < close; j++) {
        const m = META.exec(lines[j]);
        if (m) meta.set(m[1].toLowerCase(), { value: clean(m[2]), index: j });
      }
      i = close + 1;
    }
  }
  while (i < lines.length && lines[i].trim() === "") i++;
  const title = lines[i]?.startsWith("# ") ? i : -1;
  if (title >= 0) i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  for (; i < lines.length; i++) {
    const m = META.exec(lines[i]);
    if (!m || lines[i].startsWith("#")) break;
    meta.set(m[1].toLowerCase(), { value: clean(m[2]), index: i });
  }
  return { lines, meta, title };
};

export const statusOf = (text: string) => headerOf(text).meta.get("status")?.value.toLowerCase();

const withStatus = (text: string, value: string) => {
  const { lines, meta, title } = headerOf(text);
  const at = meta.get("status");
  if (at) lines[at.index] = lines[at.index].replace(/(:\**[ \t]*).*$/, `$1${value}`);
  else if (title >= 0) lines.splice(title + 1, 0, "", `Status: ${value}`, ...(lines[title + 1]?.trim() ? [""] : []));
  else lines.unshift(`Status: ${value}`, "");
  return lines.join("\n");
};

export type FileTicket = { id: string; path: string; feature: string; number: string; text: string; status?: string; blockedBy: string[] };

export const readTicket = (root: string, path: string, feature = "", number = ""): FileTicket => {
  const text = readFileSync(join(root, path), "utf8");
  const { meta } = headerOf(text);
  // Bare numbers only ("01, 02"): a path or "#12" here is a body-style blocker, read elsewhere.
  const blockedBy = (meta.get("blocked by")?.value.split(/[,\s]+/) ?? []).filter((t) => /^\d+$/.test(t)).map((n) => String(Number(n)).padStart(2, "0"));
  return { id: feature ? `${slug(feature)}-${number}` : path, path, feature, number, text, status: statusOf(text), blockedBy };
};

const files = (project: Project, dir: string, done: string[]): Tracker => {
  const root = project.root;
  const commit = (path: string, message: string) => {
    cache = undefined;
    sh("git", ["add", "--", path], root);
    sh("git", ["commit", "-q", "--no-verify", "-m", message, "--", path], root);
  };
  // One directory scan serves a burst of calls (blockers, views, the status
  // view's refresh); a write drops it.
  let cache: { at: number; list: FileTicket[] } | undefined;
  const scan = (): FileTicket[] => {
    if (cache && Date.now() - cache.at < 1000) return cache.list;
    const out: FileTicket[] = [];
    const base = join(root, dir);
    if (existsSync(base)) {
      for (const feature of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const issues = join(base, feature.name, "issues");
        if (!existsSync(issues)) continue;
        for (const f of readdirSync(issues).sort()) {
          const m = f.match(/^(\d+)-.+\.md$/);
          if (m) out.push(readTicket(root, join(dir, feature.name, "issues", f), feature.name, String(Number(m[1])).padStart(2, "0")));
        }
      }
    }
    // Two tickets sharing an id would make "close" edit the wrong file.
    const seen = new Map<string, string>();
    for (const t of out) {
      if (/^-|--/.test(t.id) || !slug(t.feature)) throw new Error(`Ticket ${t.path} has no usable id: its feature folder needs letters or digits.`);
      const other = seen.get(t.id);
      if (other) throw new Error(`Tickets ${other} and ${t.path} both map to the id ${t.id}. Rename one.`);
      seen.set(t.id, t.path);
    }
    cache = { at: Date.now(), list: out };
    return out;
  };
  const find = (id: string) => {
    const t = scan().find((x) => x.id === id);
    if (!t) throw new OperatorError(`No ticket ${id} under ${dir}/*/issues/.`);
    return t;
  };
  const split = (text: string) => {
    const at = text.search(/^## Comments\b/m);
    return at < 0 ? { body: text, comments: [] as string[] } : { body: text.slice(0, at), comments: [text.slice(at)] };
  };
  const toTicket = (t: FileTicket): Ticket => ({
    id: t.id,
    title: t.text.match(/^#\s+(.+)$/m)?.[1] ?? t.path,
    ...split(t.text),
    status: t.status,
  });
  const isDone = (t: FileTicket) => !!t.status && done.includes(t.status);
  const write = (t: FileTicket, status: string | undefined, comment?: string) => {
    let text = readFileSync(join(root, t.path), "utf8");
    if (status) text = withStatus(text, status);
    if (comment === undefined) return writeFileSync(join(root, t.path), text);
    const heading = /^## Comments\b/m.test(text) ? "" : "\n## Comments\n";
    writeFileSync(join(root, t.path), `${text.trimEnd()}\n${heading}\n### ${new Date().toISOString().slice(0, 10)} - sandcastle\n\n${comment.trim()}\n`);
  };
  // Whoever last touched the ticket, by git: the mtime of a checkout says nothing.
  const lastCommitAt = (path: string) => {
    const t = sh("git", ["log", "-1", "--format=%ct", "--", path], root);
    return t ? Number(t) : undefined;
  };
  return {
    kind: "files",
    agentsWrite: false,
    ref: (id) => id,
    queued: () => scan().filter((t) => t.status === project.label).map((t) => ({ ...toTicket(t), updated: lastCommitAt(t.path) })),
    open: () => scan().filter((t) => !isDone(t)).map(toTicket),
    get: (id) => {
      const t = find(id);
      return { ...toTicket(t), open: !isDone(t), held: isHeld(project, t.status) };
    },
    // The ticket's text as the host has it now, not the sandbox's checkout: an
    // agent branch kept from an earlier run would show an older copy. Passed
    // as an argument, so nothing in it is ever run as a shell command.
    promptArgs: (id) => ({ TICKET_BODY: fence(find(id).text) }),
    comment: (id, text) => {
      const t = find(id);
      write(t, undefined, text);
      commit(t.path, `sandcastle: comment on ${id}`);
    },
    close: (id, text) => {
      const t = find(id);
      write(t, done[0], text);
      commit(t.path, `sandcastle: close ${id}`);
    },
    hold: (id, text) => {
      const t = find(id);
      write(t, project.tracker.held, text);
      commit(t.path, `sandcastle: hold ${id} for a human`);
    },
    requeue: (id, note) => {
      const t = find(id);
      write(t, project.label, note);
      // Not "sandcastle: ...": reopenedSince ignores those as the kit's own
      // commits, and a requeue is a person asking for more work.
      commit(t.path, `requeue ${id} (sandcastle requeue)`);
    },
    snapshot: (ids) =>
      new Map(
        ids.map((id) => {
          try {
            const t = find(id);
            return [id, `${t.status ?? "no status"} ${(t.text.match(/^### /gm) ?? []).length} comment(s) ${lastCommitAt(t.path)}`];
          } catch {
            return [id, "unreadable"];
          }
        }),
      ),
    // A change to the ticket after the merge, other than our own close commit,
    // asks for more work.
    reopenedSince: (id, at) => {
      try {
        const t = find(id);
        const log = sh("git", ["log", "--format=%ct%x09%s", "--", t.path], root).split("\n").filter(Boolean);
        return log.some((l) => {
          const [ts, subject] = l.split("\t");
          return Number(ts) * 1000 > at && !subject.startsWith("sandcastle: ");
        });
      } catch {
        return true;
      }
    },
    declaredBlockers: (id) => {
      const t = find(id);
      return t.blockedBy.map((n) => `${slug(t.feature)}-${n}`);
    },
    isClosed: (id) => {
      try {
        return isDone(find(id));
      } catch {
        return undefined;
      }
    },
    words: {
      LOST: "say in a `<blocked>...</blocked>` block in your final message that the sandbox's git record was lost",
      TICKET_VIEW: "{{TICKET_BODY}}",
      COMMENTS_VIEW: "",
      NEW_TICKET: "entry under \"Follow-up:\" in your final `<report>`",
      NEW_TICKET_REVIEW: "note it in a `<report>...</report>` block in your final message under \"Follow-up:\"",
      RECORD:
        "**Before you finish, write a report** with what you changed, the commit(s), and anything a human must still do,\n" +
        "between `<report>` and `</report>` in your final message. The orchestrator posts it on the ticket and marks the\n" +
        "ticket done when your branch merges, so that report is the record. Do not edit ticket files yourself.",
      NOCHANGE: "Put the evidence in a `<report>...</report>` block in your final message.",
      BLOCKED:
        "Explain what you learned and what a human must decide inside `<blocked>...</blocked>` in your final message;\n" +
        "the orchestrator hands the ticket to a human. Do not edit ticket files yourself.",
      SAY: "in a `<report>...</report>` block in your final message",
    },
    dryRunNote:
      `**This is a dry run.** Do not edit any ticket under \`${dir}/\` and do not create one. Wherever these ` +
      "instructions ask for a report or a hand-back, put it in your final message as usual - the orchestrator posts nothing in a dry run. " +
      "Everything else - the work, the commits, the gates - is exactly as in a real run.\n\n",
  };
};

// ---------------------------------------------------------------------------
// `sandcastle requeue`
// ---------------------------------------------------------------------------

const REQUEUE_USAGE = 'Usage: sandcastle requeue <ticket> [--note "text for the next run"]';

/** The ticket id (one leading "#" dropped) and the note. The CLI reads the id from here too: the note may come first. */
export const parseRequeueArgs = (args: string[]): { id: string; note?: string } => {
  let ticket: string | undefined;
  let note: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--note") {
      note = args[++i];
      if (!note) throw new OperatorError(REQUEUE_USAGE);
    } else if (!args[i].startsWith("--") && ticket === undefined) ticket = args[i].replace(/^#/, "");
  }
  if (!ticket) throw new OperatorError(REQUEUE_USAGE);
  return { id: ticket, note };
};

/** Puts a ticket back in the queue, or only adds the note to one still queued. Returns what to tell the operator. */
export const requeueTicket = (tracker: Tracker, label: string, args: string[]): string => requeueTicketWithEffect(tracker, label, args).message;

/** What a GitHub label change leaves behind: `gh issue list --label` can miss the ticket for a few seconds. */
export const LABEL_LAG_REMINDER = "GitHub's label search can lag a few seconds: give it a moment before `sandcastle run`, or a run started now may miss this ticket.";

/** `requeueTicket`, and whether it changed the queue label: only that change can leave a search stale. */
export const requeueTicketWithEffect = (tracker: Tracker, label: string, args: string[]): { message: string; relabelled: boolean } => {
  const { id, note } = parseRequeueArgs(args);
  const t = tracker.get(id);
  const ref = tracker.ref(id);
  if (!t.open) throw new OperatorError(`${ref} is closed. Reopen it first if it needs more work.`);
  const text = note && `Note for the next run, from \`sandcastle requeue\`:\n\n${note}`;
  if (t.status === label && !t.held) {
    if (!text) return { message: `${ref} is still in the queue; nothing to change. Add --note "..." to leave the next run a note.`, relabelled: false };
    tracker.comment(id, text);
    return { message: `${ref} is still in the queue; added your note.`, relabelled: false };
  }
  tracker.requeue(id, text);
  return { message: `${ref} is back in the queue (${label})${t.held ? ", no longer held" : ""}${note ? ", with your note" : ""}.`, relabelled: tracker.kind === "github" };
};

// ---------------------------------------------------------------------------
// Choosing one
// ---------------------------------------------------------------------------

export type Resolved = {
  kind: "github" | "files";
  dir: string;
  done: string[];
  source: "config" | "docs/agents" | "default";
  /** The label (GitHub) or status (files) of a ticket held for a person: the `ready-for-human` role. */
  held: string;
  /** The label agents put on the follow-up tickets they file: the `needs-triage` role. */
  triage: string;
  note?: string;
};

/** Matt Pocock's setup skill writes these; a project may never have run it. */
export const detectFromDocs = (root: string): { kind?: "github" | "files"; labels?: Record<string, string>; unsupported?: string } => {
  const out: ReturnType<typeof detectFromDocs> = {};
  const tracker = join(root, "docs/agents/issue-tracker.md");
  if (existsSync(tracker)) {
    const named = readFileSync(tracker, "utf8").match(/^#\s*Issue tracker:\s*(.+)$/im)?.[1].trim() ?? "";
    const title = named.toLowerCase();
    if (title.startsWith("github")) out.kind = "github";
    else if (title.startsWith("local")) out.kind = "files";
    else if (title) out.unsupported = named;
  }
  // Each row maps one of Matt's triage roles to this repo's label: "| `ready-for-agent` | `agent-ready` | ...".
  const labels = join(root, "docs/agents/triage-labels.md");
  if (existsSync(labels)) {
    const rows = [...readFileSync(labels, "utf8").matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*`?([^`|]+?)`?\s*\|/gim)];
    if (rows.length) out.labels = Object.fromEntries(rows.map((m) => [m[1].toLowerCase(), m[2]]));
  }
  return out;
};

export const resolveTracker = (root: string, config?: TrackerConfig): Resolved => {
  const found = detectFromDocs(root);
  const held = found.labels?.["ready-for-human"] ?? "ready-for-human";
  const triage = found.labels?.["needs-triage"] ?? "needs-triage";
  // A repo that calls `wontfix` something else closes ticket files with that status too.
  const wontfix = found.labels?.wontfix?.toLowerCase();
  const done = wontfix && !DEFAULT_DONE.includes(wontfix) ? [...DEFAULT_DONE, wontfix] : DEFAULT_DONE;
  if (config) {
    const c = typeof config === "string" ? { type: config } : config;
    return { kind: c.type, dir: (c as { dir?: string }).dir ?? ".scratch", done: (c as { done?: string[] }).done ?? done, source: "config", held, triage };
  }
  if (found.kind) return { kind: found.kind, dir: ".scratch", done, source: "docs/agents", held, triage };
  return {
    kind: "github",
    dir: ".scratch",
    done,
    source: "default",
    held,
    triage,
    note: found.unsupported ? `docs/agents/issue-tracker.md names "${found.unsupported}", which the kit does not support yet; using GitHub. Set \`tracker\` in .sandcastle/config.ts to choose.` : undefined,
  };
};

export const makeTracker = (project: Project): Tracker =>
  project.tracker.kind === "files" ? files(project, project.tracker.dir, project.tracker.done) : github(project);
