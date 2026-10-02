// The closing summary: what a run did and what happens next, in the order an
// operator acts on it. The per-issue log above it had every fact and none of
// the consequences - no owner, no action, no order - and the facts a next
// step needs (commits not on origin, issues this run unblocked, what a
// conflict was on, a test failing on several red branches) were gathered by
// hand after the run. Printed at the end of `sandcastle run` and by
// `sandcastle report`, from run.json, git and the tracker.
//
// Every section is printed, "none" when empty, so a missing one is never
// mistaken for good news. gather() reads the world; render() is pure, so the
// sections are testable without a repo (test/report.test.ts).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterTurn, stillOpen } from "./autonomy.ts";
import { blockerResolver, blockerWhy, openBlockers, refLabel, whyShort } from "./blockers.ts";
import type { Project } from "./config.ts";
import { addTokens, NO_TOKENS, type TicketRecord, type Tokens, tokenLine } from "./run.ts";
import { sh } from "./sandbox.ts";
import { makeTracker, refOf } from "./tracker.ts";

export type Facts = {
  base: string;
  tracker: "github" | "files";
  started: string;
  finished?: string;
  live: boolean;
  /** No finishedAt and its process gone: killed, so its end time is unknown. */
  killed?: boolean;
  dryRun: boolean;
  tokens?: string;
  /** This run's tokens summed from timings.jsonl, with the cached share. */
  tokenTotal?: Tokens;
  /** The same, per model; "model not recorded" for lines written before the model was. */
  byModel?: Record<string, Tokens>;
  verify?: { green: boolean; line: string } | null;
  gateCount: number;
  tickets: Record<string, TicketRecord>;
  /** Blocked tickets whose blockers are all closed now, after landing. */
  runnable: string[];
  /** Blocked tickets still waiting, with each open blocker's label. */
  // `why`: by blocker label, what keeps one from closing (not planned, held, not queued).
  blocked: { id: string; on: string[]; why?: Record<string, string> }[];
  /** Why the blockers could not be re-read, if they could not. */
  blockCheck?: string;
  /** Commits on the base branch not on its upstream (as of the last fetch); undefined with no upstream. */
  ahead?: number;
  upstream?: string;
  /** Agent branches with work not on the base branch. */
  standing: string[];
  keptWorktrees: { issue: string; path: string }[];
  dryRunCheck?: string;
  /** Why the run stopped before landing, if it did. */
  stopped?: string;
  /** Files changed per held branch. */
  changed: Record<string, number>;
  /** Issues agents filed during the run, labelled needs-triage and still open (GitHub only). */
  filed?: { id: string; title: string }[];
  /** The run record's last stage and exit code: "base gates" with a non-zero exit is a run that never started anything. */
  stage?: string;
  exitCode?: number | null;
  /** Each base gate's verdict, when the run stopped on red base gates. */
  baseGates?: { gate: string; ok: boolean }[];
  /** Set when the autonomy loop runs another turn straight after this one: nothing here is the operator's to do yet. */
  next?: { level: number; turn: number; tickets: string[] };
};

/** The one line the close comment and the closing report share for a diff that left its `Touches:` line. */
export const overrunLine = (paths: string[]) => `changed beyond its Touches line: ${paths.join(", ")}`;

export const NEEDS_FIXING = ["red", "conflict", "crashed", "not landed"];
const LEFT = ["blocked", "skipped"];
// A ticket the landing worker found green alone and red once merged says so in its note (src/landing.ts);
// a red gate in its own pipeline names the failing gates instead. The difference is the pair, not the gate.
const redTogether = (t: TicketRecord) => t.state === "red" && /^red (with|on the merged)/.test(t.note ?? "");
// Where a ticket's part in a run ends. Any other state at the end - a phase, or
// "ready" outside a dry run - is a ticket the run stopped mid-work.
const SETTLED = ["merged", "nochange", "withdrawn", "stopped", "held", "shipped", "queued", "requeued", ...NEEDS_FIXING, ...LEFT];

// A run that started agents owes a summary (due); an exit before it is printed
// (Ctrl-C, a crash) says where to find one instead of ending silently.
export const summary = { due: false, printed: false };

// Git is asked, never assumed: a repo with no upstream, a deleted branch.
const git = (args: string[], cwd: string) => {
  try {
    return sh("git", args, cwd);
  } catch {
    return undefined;
  }
};

const NO_MODEL = "model not recorded";

/** One run's tokens from timings.jsonl text: in total and per model. Undefined when no line of the run carries tokens. */
export const tokensFromTimings = (text: string, runId: string): { total: Tokens; byModel: Record<string, Tokens> } | undefined => {
  let total: Tokens | undefined;
  const byModel: Record<string, Tokens> = {};
  for (const raw of text.split("\n")) {
    let line: { run?: unknown; tokens?: Tokens; model?: unknown };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!line || line.run !== runId || !line.tokens || typeof line.tokens !== "object") continue;
    const model = typeof line.model === "string" && line.model ? line.model : NO_MODEL;
    total = addTokens(total ?? NO_TOKENS, line.tokens);
    byModel[model] = addTokens(byModel[model] ?? NO_TOKENS, line.tokens);
  }
  return total ? { total, byModel } : undefined;
};

export const gather = async (project: Project): Promise<Facts> => {
  const root = project.root;
  const base = project.baseBranch;
  const run = JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8"));
  const tickets = (run.tickets ?? {}) as Record<string, TicketRecord>;
  const pid = Number(run.pid);
  const live = !run.finishedAt && (() => {
    try {
      process.kill(pid, 0);
      return pid !== process.pid;
    } catch {
      return false;
    }
  })();

  // Blockers read again now: this run's own merges close some of them, and a
  // list from the start of the run said "blocked" for issues ready to go.
  const runnable: string[] = [];
  const blocked: Facts["blocked"] = [];
  let blockCheck: string | undefined;
  const waiting = Object.entries(tickets).filter(([, t]) => t.state === "blocked").map(([id]) => id);
  if (waiting.length) {
    try {
      const tracker = makeTracker(project);
      const resolve = blockerResolver(project, tracker);
      const whyOf = blockerWhy(project, tracker);
      for (const id of waiting) {
        const t = tracker.get(id);
        if (!t.open) continue;
        const open = await openBlockers(project, tracker, resolve, t);
        const on = open.map(refLabel);
        const why = Object.fromEntries(open.flatMap((b) => { const w = whyOf(b); return w ? [[refLabel(b), whyShort[w]]] : []; }));
        if (on.length) blocked.push({ id, on, ...(Object.keys(why).length ? { why } : {}) });
        else runnable.push(id);
      }
    } catch (error) {
      blockCheck = String(error).split("\n")[0].slice(0, 160);
      for (const id of waiting) blocked.push({ id, on: [] });
    }
  }

  const upstream = git(["rev-parse", "--abbrev-ref", `${base}@{upstream}`], root);
  const ahead = upstream ? Number(git(["rev-list", "--count", `${upstream}..${base}`], root) ?? NaN) : undefined;
  const standing = (git(["branch", "--format=%(refname:short)", "--list", "agent/*"], root) ?? "")
    .split("\n")
    .filter((b) => b && (git(["cherry", base, b], root) ?? "").split("\n").some((l) => l.startsWith("+")));
  const changed: Record<string, number> = {};
  for (const [id, t] of Object.entries(tickets)) {
    if (t.state !== "held") continue;
    const files = git(["diff", "--name-only", `${base}...agent/issue-${id}`], root);
    if (files !== undefined) changed[id] = files.split("\n").filter(Boolean).length;
  }

  // Agent-filed follow-ups: open, labelled needs-triage, created since the run
  // began. Dates are compared here, not with a shell `date`, which differs on macOS.
  let filed: { id: string; title: string }[] = [];
  if (project.tracker.kind === "github") {
    try {
      const open = JSON.parse(sh("gh", ["issue", "list", "--state", "open", "--label", "needs-triage", "--limit", "500", "--json", "number,title,createdAt"], root)) as { number: number; title: string; createdAt: string }[];
      filed = open.filter((i) => Date.parse(i.createdAt) >= Date.parse(run.startedAt)).map((i) => ({ id: String(i.number), title: i.title }));
    } catch {
      filed = [];
    }
  }

  const timingsFile = join(root, ".sandcastle/logs/timings.jsonl");
  const timed = existsSync(timingsFile) ? tokensFromTimings(readFileSync(timingsFile, "utf8"), run.startedAt) : undefined;

  return {
    base,
    tracker: project.tracker.kind,
    started: run.startedAt,
    finished: run.finishedAt,
    live,
    killed: !run.finishedAt && !live && pid !== process.pid,
    dryRun: !!run.dryRun,
    tokens: run.tokens,
    tokenTotal: timed?.total,
    byModel: timed?.byModel,
    verify: run.verify,
    gateCount: project.gates.length,
    tickets,
    runnable,
    blocked,
    blockCheck,
    ahead: Number.isNaN(ahead) ? undefined : ahead,
    upstream,
    standing,
    keptWorktrees: run.keptWorktrees ?? [],
    dryRunCheck: run.dryRunCheck,
    stopped: run.stopped,
    changed,
    filed,
    stage: run.stage,
    exitCode: run.exitCode,
    baseGates: run.baseGates,
  };
};

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const span = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/** The closing summary as Markdown-ish text, every section present. */
export const render = (f: Facts, plain = false): string => {
  const ids = (states: string[]) => Object.entries(f.tickets).filter(([, t]) => states.includes(t.state ?? "")).map(([id]) => id);
  const name = (id: string) => `${refOf(id)}${f.tickets[id]?.title ? ` ${f.tickets[id].title}` : ""}`;
  const list = (xs: string[]) => xs.map(refOf).join(" ") || "none";
  const merged = ids(["merged"]);
  // Merged, but the tracker refused the close: the work is on base, the ticket still open.
  const notClosed = merged.filter((id) => f.tickets[id].closeFailed);
  const closed = merged.filter((id) => !notClosed.includes(id));
  // Merged with green gates, but the reviewer said no gate exercises the change. Only merged
  // tickets: a held or red one is already in front of a person, and a dry run merges nothing.
  const ungated = merged.filter((id) => f.tickets[id].ungated);
  const held = ids(["held"]);
  // Held with nothing on its branch: an agent handed it back, or a person took
  // it before any commit. There is nothing to review or merge - only a question.
  const handedBack = held.filter((id) => f.changed[id] === 0);
  // Marked needs-human by a person mid-run: they took it; the branch is only there if it helps.
  const takenBack = held.filter((id) => !handedBack.includes(id) && f.tickets[id].note?.startsWith("marked needs-human"));
  const heldWork = held.filter((id) => !handedBack.includes(id) && !takenBack.includes(id));
  const fixing = ids(NEEDS_FIXING);
  // Put back in the queue while the run was going (landing found it red together with another ticket, say):
  // it runs again next time, and nothing here asks a person to act on it.
  const requeued = ids(["requeued"]);
  // The gates on the base were red before any agent ran: nothing was attempted,
  // and the queue is untouched. Said first, as nothing below it is news.
  const baseRed = f.stage === "base gates" && !!f.finished && typeof f.exitCode === "number" && f.exitCode !== 0 &&
    !Object.values(f.tickets).some((t) => t.started);
  // Ended before its summary (Ctrl-C, a crash, kill -9): its tickets mid-work were
  // counted as attempted and listed nowhere, under a headline that said "finished".
  const early = !baseRed && !f.stopped && !f.live &&
    (!!f.killed || (!!f.finished && f.stage !== "report" && typeof f.exitCode === "number" && f.exitCode !== 0));
  const cut = early ? Object.keys(f.tickets).filter((id) => !SETTLED.includes(f.tickets[id].state ?? "") && !(f.dryRun && f.tickets[id].state === "ready")) : [];
  const unstarted = early ? ids(["queued"]) : [];
  const notStarted = ids(baseRed ? ["queued", ...LEFT] : LEFT).concat(unstarted);
  const nochange = ids(["nochange"]);
  const withdrawn = ids(["withdrawn"]);
  const stoppedIds = ids(["stopped"]);
  // A dry run's green branches end as "ready": they would have merged.
  const wouldMerge = f.dryRun ? ids(["ready"]) : [];
  // Withdrawn before its sandbox started: someone's decision, not an attempt.
  const attempted = baseRed ? 0 : Object.values(f.tickets).filter((t) => !LEFT.includes(t.state ?? "") && !(t.state === "withdrawn" && !t.started)).length - unstarted.length;
  const closedWhere = f.tracker === "github" ? "closed on GitHub" : "marked done in their ticket files (committed on your local " + f.base + ")";
  const out: string[] = [];
  // NO_COLOR asks for no decoration; the caller decides, so render stays pure.
  const h = (decorated: string, bare: string) => (plain ? bare : decorated);
  const section = (heading: string, lines: string[]) => out.push("", heading, ...(lines.length ? lines : ["none"]));

  // Headline. A killed run wrote no end: "now" would be whenever the report
  // was asked for, perhaps hours later, and "finished" would be untrue.
  const end = f.finished ?? (f.killed ? undefined : new Date().toISOString());
  out.push(
    baseRed
      ? `${h("## 🏁 Run", "## Run")} stopped: red on ${f.base} before any agent ran - nothing was started`
      : `${h("## 🏁 Run", "## Run")} ${f.stopped ? (merged.length ? `STOPPED - ${merged.length} merged before it stopped` : "STOPPED before landing - nothing was merged") : f.live ? "still running - partial summary" : f.killed ? "ended without a clean exit (killed?) - partial summary" : early ? `ended early (exit ${f.exitCode}) - partial summary` : "finished"}${f.dryRun ? " (dry run)" : ""}`,
    (end ? `${hhmm(f.started)} to ${hhmm(end)} (${span(Date.parse(end) - Date.parse(f.started))})` : `From ${hhmm(f.started)}, end not recorded`) +
      ` - ${attempted} attempted - ` +
      `${f.dryRun ? `${wouldMerge.length} would merge` : `${merged.length} merged`} - ${held.length + new Set([...notClosed, ...ungated]).size} need you - ${fixing.length} need fixing - ` +
      `${notStarted.length} not started${f.tokenTotal ? ` - tokens ${tokenLine(f.tokenTotal)}` : f.tokens ? ` - tokens ${f.tokens}` : ""}`,
    baseRed
      ? `Base gates: red - ${f.baseGates?.filter((g) => !g.ok).map((g) => g.gate).join(", ") || "failing gates not recorded; see .sandcastle/logs/base-gates.log"}`
      : f.verify === undefined || f.verify === null
      // null: the run ended and chose not to (fewer than two merges this run - a
      // ticket closed as merged earlier merges nothing); undefined: it never got there.
      ? `Merged ${f.base} not re-gated (${f.verify === null ? "fewer than two branches merged in this run" : early ? "the run ended before it got there" : "no result recorded"}).`
      : f.verify.green
        ? `Merged ${f.base} re-gated: all ${f.gateCount} gates green.`
        : `Merged ${f.base} re-gated: RED TOGETHER (${f.verify.line}) - do not push ${f.base} until it is fixed.`,
  );
  const models = Object.entries(f.byModel ?? {});
  if (models.some(([model]) => model !== NO_MODEL)) {
    const size = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead + t.output;
    out.push(`Tokens by model: ${models.sort(([, a], [, b]) => size(b) - size(a)).map(([model, t]) => `${model} ${tokenLine(t)}`).join(" · ")}`);
  }
  if (f.stopped) out.push(f.stopped);
  if (f.dryRunCheck) out.push(f.dryRunCheck);

  // Done
  const done: string[] = [];
  if (closed.length) done.push(`${closed.length} merged and ${closedWhere}: ${list(closed)}`);
  // Merged with the close refused: done in git, still open in the tracker - not "closed on GitHub".
  if (notClosed.length) done.push(`${notClosed.length} merged, but still open in the tracker: ${list(notClosed)} (see Needs you)`);
  if (closed.length && f.tracker === "github") done.push(`Closed on GitHub, but the code is only on your local ${f.base} until you push it.`);
  else if (merged.length) done.push(`The code is only on your local ${f.base} until you push it.`);
  if (wouldMerge.length) {
    // Each branch was gated alone; whether they merge together is a separate question.
    const together = wouldMerge.length > 1 ? " Each was gated on its own: `sandcastle preview` shows which would conflict with each other." : "";
    done.push(`Dry run - green, would merge: ${list(wouldMerge)}. Nothing was merged or closed.${together}`);
  }
  // A warning on a ticket that landed: the line is agent-written, so nothing was held for it.
  for (const id of merged.filter((id) => f.tickets[id].overrun?.length)) done.push(`${name(id)} ${overrunLine(f.tickets[id].overrun!)}`);
  if (nochange.length) done.push(`Nothing to change: ${list(nochange)} - left open, with the agent's evidence in a comment`);
  // Someone's decision during the run; its branch stands in case they want it.
  for (const id of withdrawn) {
    const kept = f.standing.includes(`agent/issue-${id}`) ? ` (branch agent/issue-${id} kept)` : "";
    done.push(`Not landed, as the tracker now says: ${name(id)} - ${f.tickets[id].note ?? "withdrawn"}${kept}`);
  }
  section(h("## ✅ Done", "## Done"), done);

  // Needs you
  section(
    h("## 🙋 Needs you", "## Needs you"),
    [
      ...heldWork.flatMap((id) => {
        const t = f.tickets[id];
        const size = f.changed[id] !== undefined ? ` - ${f.changed[id]} file(s)` : "";
        const why = t.files?.length ? `changes ${t.files.join(", ")}` : (t.note ?? "held");
        return [`- ${name(id)} - ${why}${size}`, `  review: git log -p ${f.base}..agent/issue-${id}   merge: git merge --no-ff agent/issue-${id}`];
      }),
      ...takenBack.map((id) => `- ${name(id)} - ${f.tickets[id].note} - branch agent/issue-${id} has the agents' work, if it helps`),
      ...handedBack.map((id) => `- ${name(id)} - ${f.tickets[id].note ?? "held"}, no commits - read the agent's comment: do it yourself and close the ticket, or answer its question and requeue it`),
      // The next run finds its own merge message and closes the ticket, so
      // nobody should merge or redo the work.
      ...notClosed.map(
        (id) => `- ${name(id)} - merged, but closing the ticket failed: ${f.tickets[id].closeFailed} - the next \`sandcastle run\` closes it, or close it by hand`,
      ),
      ...ungated.map((id) => `- ${name(id)} - merged - check by hand: ${f.tickets[id].ungated}`),
      ...(f.filed ?? []).map((i) => `- #${i.id} ${i.title} - filed by an agent during this run (needs-triage): triage it, then queue or close it`),
    ],
  );

  // Needs fixing, with what several branches have in common
  const fixLines = fixing.map((id) => {
    const t = f.tickets[id];
    const what = t.state === "conflict"
      ? `merge conflict: ${t.note ?? ""}`
      : redTogether(t)
        // Its gates passed on its own branch: the fix is in how it meets the tickets named, not in its own tests.
        ? `${t.note!.replace(/^red /, "red together ")} (green on its own branch)`
        : t.state === "red" ? `gate ${t.note ?? "red"}` : `${t.state}: ${t.note ?? ""}`;
    const tests = t.failing?.length ? ` - failing: ${t.failing.join(", ")}` : "";
    return `- ${name(id)} - ${what}${tests} (branch agent/issue-${id})`;
  });
  // One test failing on several branches is likely one cause. One file only
  // says where to look first: two branches can conflict in a file, or fail
  // different tests in it, for unrelated reasons.
  const group = (key: (id: string) => string[]) => {
    const by = new Map<string, string[]>();
    for (const id of [...fixing, ...held]) for (const k of new Set(key(id))) by.set(k, [...(by.get(k) ?? []), id]);
    return [...by].filter(([, who]) => who.length > 1);
  };
  const sameTest = group((id) => f.tickets[id].failing ?? []);
  const inSameTest = (file: string, who: string[]) => sameTest.some(([test, w]) => test.split("::")[0] === file && who.every((id) => w.includes(id)));
  const sameFile = group((id) => {
    const t = f.tickets[id];
    return [...(t.state === "held" ? [] : (t.files ?? [])), ...(t.failing ?? []).map((x) => x.split("::")[0])];
  }).filter(([file, who]) => !inSameTest(file, who));
  for (const [test, who] of sameTest) fixLines.push(`Same failing test: ${test} - on ${list(who)}. Likely one cause: fix it once.`);
  for (const [file, who] of sameFile) fixLines.push(`Same file: ${file} - ${list(who)} fail or conflict there. Check whether it is one cause.`);
  section(h("## ❌ Needs fixing (failed or conflicted)", "## Needs fixing (failed or conflicted)"), fixLines);

  // Runnable / blocked
  const ticketState = (label: string) => {
    const id = Object.keys(f.tickets).find((k) => refOf(k) === label || k === label);
    const s = id ? f.tickets[id].state : undefined;
    return s && s !== "merged" ? ` (${s === "red" ? (redTogether(f.tickets[id!]) ? "red together" : "gate red") : s})` : "";
  };
  const skipped = ids(["skipped"]);
  // Why each one can run, from the record: a ticket held for an overlap says which ticket it waited
  // for (and whether that one landed); one that waited on blockers, which; a conflicted one resumes its branch.
  const runnableWhy = (id: string) => {
    const t = f.tickets[id] ?? {};
    if (t.state === "conflict") return "conflicted - its branch resumes";
    const overlap = /^waits for (\S+) \(this run\) - next run$/.exec(t.note ?? "");
    if (overlap) {
      const partner = Object.keys(f.tickets).find((k) => refOf(k) === overlap[1] || k === overlap[1]);
      const state = partner ? f.tickets[partner].state : undefined;
      return `held for overlap with ${overlap[1]}${state === "merged" ? ", now landed" : state ? ` (${state})` : ""}`;
    }
    const on = /^waits for (.*)$/.exec(t.note ?? "")?.[1]?.replace(/\s*\([^)]*\)/g, "").split(",").map((l) => l.trim()).filter(Boolean) ?? [];
    return on.length ? `${on.length === 1 ? "blocker" : "blockers"} ${on.join(", ")} closed` : "blockers closed";
  };
  const runnable = [...new Set([...Object.keys(f.tickets).filter((id) => f.runnable.includes(id) || f.tickets[id].state === "conflict"), ...f.runnable])];
  const anyLeft = runnable.length + f.blocked.length + skipped.length + requeued.length + cut.length + unstarted.length > 0 || !!f.blockCheck;
  section(h("## ▶️ Runnable now / ⏳ Still blocked", "## Runnable now / Still blocked"), anyLeft ? [
    `▶️ Runnable now: ${runnable.length ? runnable.map((id) => `${refOf(id)} (${runnableWhy(id)})`).join(", ") : "none"}`,
    ...f.blocked.map((b) => `⏳ ${refOf(b.id)} waits for ${b.on.map((l) => `${l}${ticketState(l)}${b.why?.[l] ? ` - ${b.why[l]}` : ""}`).join(", ") || "blockers that could not be read"}`),
    ...(skipped.length ? [`Not started (the run stopped early): ${list(skipped)}`] : []),
    ...requeued.map((id) => `Requeued: ${name(id)}${f.tickets[id].note ? ` - ${f.tickets[id].note}` : ""} - still queued for the next run`),
    ...(cut.length ? [`Cut short when the run ended: ${cut.map((id) => `${refOf(id)} (${f.tickets[id].state})`).join(", ")} - still queued`] : []),
    ...(unstarted.length ? [`Not started (the run ended early): ${list(unstarted)}`] : []),
    ...(f.blockCheck ? [`Could not re-read blockers: ${f.blockCheck}`] : []),
  ] : []);

  // Local state
  section(h("## 📤 Local state", "## Local state"), [
    f.ahead === undefined
      ? `${f.base} has no upstream to compare with.`
      : `${f.base} is ${f.ahead} commit(s) ahead of ${f.upstream} (as of the last fetch).`,
    "Nothing is pushed by Sandcastle. Push by this repo's own rules (for example `git push`, or a pull request).",
    `Agent branches with unmerged work: ${f.standing.length ? f.standing.join(", ") : "none"}`,
    ...f.keptWorktrees.map((k) => `Worktree kept with uncommitted files: ${refOf(k.issue)} - ${k.path}`),
  ]);

  // Next step: the first thing that unblocks the most, then the rest in order.
  const next: string[] = [];
  if (baseRed) {
    next.push(
      `Fix the base: read .sandcastle/logs/base-gates.log, then \`sandcastle gates\` to check; the queue is untouched, so \`sandcastle run\` afterwards starts the same tickets.`,
    );
  }
  if (f.stopped) {
    next.push(
      `Check what stopped the run (above). If it is your own commit, \`sandcastle run\` again` +
        (stoppedIds.length ? ` - ${list(stoppedIds)} finished and land then.` : "."),
    );
  }
  if (f.verify && !f.verify.green) next.push(`Fix ${f.base}: merged together, the gates are red. Do not push until they are green.`);
  if (sameTest.length) next.push(`Fix ${sameTest.map(([test]) => test).join(", ")} once - it fails on ${new Set(sameTest.flatMap(([, w]) => w)).size} of the unmerged branches.`);
  // Grouped, these tickets got no step of their own (see `lone`): say here what the next run does with them.
  if (sameFile.length) {
    const ids = [...new Set(sameFile.flatMap(([, w]) => w))];
    next.push(
      `Start with ${sameFile.map(([file]) => file).join(", ")}: ${list(ids)} fail or conflict there. They are still queued: ` +
        `the next \`sandcastle run\` resumes each branch, merging ${f.base} into it first; or fix one yourself and land it: \`sandcastle land <n>\`.`,
    );
  }
  if (heldWork.length) next.push(`Review and merge the ${heldWork.length} held branch(es) (commands above).`);
  if (handedBack.length) next.push(`Read the agent's comment on ${list(handedBack)}: work only a person can do, do it and close the ticket; a question, answer it and requeue: \`sandcastle requeue <ticket> --note "..."\`.`);
  if (notClosed.length) next.push(`Close ${list(notClosed)} (merged, still open), or leave it to the next \`sandcastle run\`.`);
  if (ungated.length) next.push(`Check ${list(ungated)} by hand: merged, but no gate exercises the change (what to check is under Needs you).`);
  const lone = fixing.filter((id) => ![...sameTest, ...sameFile].some(([, w]) => w.includes(id)));
  // These tickets keep their queue label (the kit only comments on them), so "requeue" sent operators
  // looking for a step that does not exist; the next run resumes the kept branch instead.
  // `sandcastle land` merges and gates the way a run does; a hand-written merge skips both.
  if (lone.length) next.push(`Look at ${list(lone)}: still queued - add a comment for the implementer if it helps, and the next \`sandcastle run\` resumes its branch; or fix the branch yourself and land it: \`sandcastle land ${lone.length === 1 ? lone[0] : "<n>"}\`.`);
  // Never closed by the kit (the agent may be wrong), and still queued: every later run would pay for it again.
  if (nochange.length) next.push(`Read the agent's comment on ${list(nochange)} (nothing to change): close it if the evidence holds, or add what is missing - while it stays queued, every \`sandcastle run\` tries it again.`);
  if (f.runnable.length) next.push(`Run again for the ${f.runnable.length} issue(s) this run unblocked: \`sandcastle run\`.`);
  if (skipped.length) next.push(`Run again for the ${skipped.length} issue(s) that never started.`);
  if (requeued.length) next.push(`\`sandcastle run\` again for ${list(requeued)}: requeued during this run.`);
  // They keep their queue label, and the next run resumes a kept branch rather than starting over.
  if (cut.length + unstarted.length) {
    next.push(
      `\`sandcastle run\` again: it picks up ${list([...cut, ...unstarted])} where this run ended` +
        (f.killed ? ", and first stops any sandbox the killed run left working." : "."),
    );
  }
  // A red base is red for whoever pulls it too.
  const push = f.ahead ? (baseRed ? `Do not push ${f.base} (${f.ahead} commit(s)) until its gates are green.` : `Push ${f.base} (${f.ahead} commit(s)) under this repo's rules.`) : undefined;
  if (push) next.push(push);
  if (f.standing.length && !baseRed) next.push("`sandcastle clean` once the branches above are resolved.");
  // Another turn follows at once: everything above is that turn's work, and only the last turn's steps are the operator's.
  const steps = f.next
    ? [`Autonomy level ${f.next.level} runs turn ${f.next.turn} of ${f.next.level} next for ${f.next.tickets.map(refOf).join(", ")}; nothing to do yet.`, ...(push ? [push] : [])]
    : next;
  section(h("## 👉 Next step", "## Next step"), steps.map((n, i) => `${i + 1}. ${n}`));
  return out.join("\n");
};

/** The summary for the project's last recorded run. */
export const closingReport = async (project: Project, turn?: { level: number; turn: number }) => {
  if (!existsSync(join(project.root, ".sandcastle/logs/run.json"))) return "No run recorded yet.";
  const facts = await gather(project);
  summary.printed = true;
  if (!Object.keys(facts.tickets).length) return "The last run predates the per-ticket record; its report is in the run pane's output.";
  // NO_COLOR counts as set only when non-empty (no-color.org).
  // The same verdict the loop reaches after this turn (cli.ts): its next step is the loop's, not the operator's.
  if (turn) {
    const after = afterTurn(facts, turn.level, turn.turn, stillOpen(makeTracker(project)));
    if (after?.verdict === "run") facts.next = { level: turn.level, turn: turn.turn + 1, tickets: after.ids };
  }
  return render(facts, !!process.env.NO_COLOR);
};
