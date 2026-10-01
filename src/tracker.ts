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

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { sh } from "./sandbox.ts";

export type Ticket = { id: string; title: string; body: string; comments: string[]; updated?: number; status?: string };
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
  /** One ticket now, for `ISSUES=` and the check just before landing. */
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
  /** State, labels and comment count, to prove a dry run wrote nothing. */
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

export const isNumeric = (id: string) => /^\d+$/.test(id);
export const refOf = (id: string) => (isNumeric(id) ? `#${id}` : id);

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

const github = (project: Project): Tracker => {
  const gh = (args: string[]) => sh("gh", args);
  const list = (extra: string[], withComments: boolean): Ticket[] => {
    const listed = JSON.parse(gh(["issue", "list", "--state", "open", ...extra, "--limit", String(LIST_LIMIT), "--json", `number,title,body,updatedAt,labels${withComments ? ",comments" : ""}`])) as any[];
    // Counted before the needs-human filter below: a full page is full whatever
    // is dropped from it. stderr, because `queue --json` is parsed from stdout.
    if (listed.length === LIST_LIMIT) {
      const label = extra[extra.indexOf("--label") + 1];
      console.warn(`gh returned the limit of ${LIST_LIMIT} open issues${extra.includes("--label") ? ` labelled ${label}` : ""}; any beyond it are not seen.`);
    }
    return listed
      // A person who marks a queued issue needs-human by hand leaves the queue
      // label on (hold() takes it off). Listed, it came back every run only to
      // be withdrawn unstarted; it is a human's until they requeue it.
      .filter((i) => !extra.includes("--label") || !i.labels.some((l: { name: string }) => l.name === "needs-human"))
      .map((i) => ({
      id: String(i.number),
      title: i.title,
      body: i.body ?? "",
      comments: (i.comments ?? []).map((c: { body: string }) => c.body),
      updated: i.updatedAt ? Math.floor(Date.parse(i.updatedAt) / 1000) : undefined,
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
        open: i.state === "OPEN",
        held: i.labels.some((l: { name: string }) => l.name === "needs-human"),
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
      gh(["label", "create", "needs-human", "--color", "D93F0B", "--force"]);
      gh(["issue", "edit", id, "--remove-label", project.label, "--add-label", "needs-human"]);
      gh(["issue", "comment", id, "--body", text]);
    },
    snapshot: (ids) =>
      new Map(
        ids.map((n) => {
          try {
            const i = JSON.parse(gh(["issue", "view", n, "--json", "state,labels,comments"]));
            return [n, `${i.state} [${i.labels.map((l: { name: string }) => l.name).sort().join(",")}] ${i.comments.length} comment(s)`];
          } catch {
            return [n, "unreadable"];
          }
        }),
      ),
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
      LOST: "comment on the issue that the sandbox's git record was lost",
      TICKET_VIEW: "!`gh issue view {{ISSUE_NUMBER}}`",
      COMMENTS_VIEW: "# Comments on the issue\n\n!`gh issue view {{ISSUE_NUMBER}} --comments`\n\n",
      NEW_TICKET: "GitHub issue (`gh issue create`)",
      NEW_TICKET_REVIEW: "open a new GitHub issue\n  (`gh issue create`)",
      RECORD:
        "**Before you finish, comment on the issue** with what you changed, the commit(s), and anything a\n" +
        "human must still do. The issue is closed automatically when your branch merges, so that comment is\n" +
        "the record.",
      NOCHANGE: "Comment on the issue with the evidence.",
      BLOCKED:
        "Comment on issue {{TICKET}} explaining what you\nlearned and what a human must decide, then add the labels:\n\n" +
        "```\ngh issue edit {{ISSUE_NUMBER}} --add-label agent-blocked --add-label needs-human --remove-label {{KIT_LABEL}}\n```",
      SAY: "in a comment on the issue",
    },
    dryRunNote:
      "**This is a dry run.** Write nothing to GitHub: do not comment on, open, close or label any issue " +
      "(`gh issue comment`, `gh issue create`, `gh issue close`, `gh issue edit`, `gh label`). Wherever these " +
      "instructions say to do one of those, put what you would have posted in your final message instead, under " +
      "\"Would post:\". Reading issues with `gh` is fine. Everything else - the work, the commits, the gates - is " +
      "exactly as in a real run.\n\n",
  };
};

// ---------------------------------------------------------------------------
// Local Markdown files
// ---------------------------------------------------------------------------

export const DEFAULT_DONE = ["done", "closed", "resolved", "wontfix"];
const HELD = "needs-human";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

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
    if (!t) throw new Error(`No ticket ${id} under ${dir}/*/issues/.`);
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
  const write = (t: FileTicket, status: string | undefined, comment: string) => {
    let text = readFileSync(join(root, t.path), "utf8");
    if (status) text = withStatus(text, status);
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
      return { ...toTicket(t), open: !isDone(t), held: t.status === HELD };
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
      write(t, HELD, text);
      commit(t.path, `sandcastle: hold ${id} for a human`);
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
// Choosing one
// ---------------------------------------------------------------------------

export type Resolved = { kind: "github" | "files"; dir: string; done: string[]; source: "config" | "docs/agents" | "default"; note?: string };

/** Matt Pocock's setup skill writes these; a project may never have run it. */
export const detectFromDocs = (root: string): { kind?: "github" | "files"; label?: string; unsupported?: string } => {
  const out: ReturnType<typeof detectFromDocs> = {};
  const tracker = join(root, "docs/agents/issue-tracker.md");
  if (existsSync(tracker)) {
    const title = readFileSync(tracker, "utf8").match(/^#\s*Issue tracker:\s*(.+)$/im)?.[1].trim().toLowerCase() ?? "";
    if (title.startsWith("github")) out.kind = "github";
    else if (title.startsWith("local")) out.kind = "files";
    else if (title) out.unsupported = title;
  }
  const labels = join(root, "docs/agents/triage-labels.md");
  if (existsSync(labels)) {
    out.label = readFileSync(labels, "utf8").match(/^\|\s*`ready-for-agent`\s*\|\s*`?([^`|]+?)`?\s*\|/im)?.[1];
  }
  return out;
};

export const resolveTracker = (root: string, config?: TrackerConfig): Resolved => {
  if (config) {
    const c = typeof config === "string" ? { type: config } : config;
    return { kind: c.type, dir: (c as { dir?: string }).dir ?? ".scratch", done: (c as { done?: string[] }).done ?? DEFAULT_DONE, source: "config" };
  }
  const found = detectFromDocs(root);
  if (found.kind) return { kind: found.kind, dir: ".scratch", done: DEFAULT_DONE, source: "docs/agents" };
  return {
    kind: "github",
    dir: ".scratch",
    done: DEFAULT_DONE,
    source: "default",
    note: found.unsupported ? `docs/agents/issue-tracker.md names "${found.unsupported}", which the kit does not support yet; using GitHub. Set \`tracker\` in .sandcastle/config.ts to choose.` : undefined,
  };
};

export const makeTracker = (project: Project): Tracker =>
  project.tracker.kind === "files" ? files(project, project.tracker.dir, project.tracker.done) : github(project);
