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
import { basename, join, resolve } from "node:path";
import { red } from "./api-key.ts";
import { afterTurn, DRAIN_CAP, type Level, needsDecision, partialRerunnable, rerunnable, stillOpen } from "./autonomy.ts";
import { blockerResolver, blockerWhy, openBlockers, refLabel, whyShort } from "./blockers.ts";
import type { Project } from "./config.ts";
import { addTokens, HANDED_BACK, mergedByHand, mergedPartly, NO_TOKENS, readHeads, readOutcomes, type Tokens, tokenLine } from "./run.ts";
import { commandOf } from "./live-runs.ts";
import { branchFinished, projectWorktrees, sh } from "./sandbox.ts";
import { readPlanUsages } from "./usage.ts";
import { LANDING_GATES, rewroteLine } from "./gates.ts";
import { LANDING_HOLD, setupProblemWords } from "./ledger.ts";
import { STRAY_NOTE_START } from "./resolution.ts";
import { isDocPath, isTestPath } from "./touches.ts";
import { makeTracker, refOf, withOpenList } from "./tracker.ts";
import { OperatorError, sameExpansionFailure } from "./errors.ts";
import { liveness, type Probe } from "../mod/hooks/run-live.ts";
import type { FiledFollowUp } from "./burndown.ts";
import { isTicketState, type OutcomeKind, type PlanUsage, readTickets, type RunSettings, type TicketRecord, type TicketState, TICKET_STATES } from "../mod/hooks/run-record.ts";

/** "stopped by `sandcastle stop`", "stopped by Ctrl-C": what a run's `stoppedBy` reads as in the summary and the notify line. */
export const stoppedByText = (by: string) => `stopped by ${by === "sandcastle stop" ? "`sandcastle stop`" : by}`;

export type Facts = {
  base: string;
  tracker: "github" | "files";
  started: string;
  finished?: string;
  live: boolean;
  /** The run record's `paused`: a person has the live run paused (seconds since the epoch). */
  paused?: { since: number };
  /** No finishedAt and its process gone: killed, so its end time is unknown. */
  killed?: boolean;
  dryRun: boolean;
  tokens?: string;
  /** This run's tokens summed from timings.jsonl, with the cached share. */
  tokenTotal?: Tokens;
  /** The same, per model; "model not recorded" for lines written before the model was. */
  byModel?: Record<string, Tokens>;
  verify?: { green: boolean; line: string; image?: string; failing?: string[]; failingMore?: boolean; dockerfiles?: string[]; gatedTree?: string; cleanTree?: string; skipped?: { commit: string; by?: string; kind?: string } } | null;
  gateCount: number;
  tickets: Record<string, TicketRecord>;
  /** This run's outcome kinds by ticket id, from outcomes.json: what tells red together from a red gate, and taken back from held. */
  outcomes?: Record<string, OutcomeKind>;
  /** Blocked tickets whose blockers are all closed now, after landing. */
  runnable: string[];
  /** Merged partly done (a criterion left unmet) and still in the queue now; undefined when the queue could not be read. */
  partial?: string[];
  /** The tracker's hold label, for the step that moves a ticket out of the queue. */
  holdLabel?: string;
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
  /** Standing branches whose ticket an earlier run held for a person, by branch: that outcome's text. A branch of this run's own, or with no outcome, is not here. */
  earlierHeld?: Record<string, string>;
  /** Tickets whose recorded outcome (any run) is a held conflict resolution: `sandcastle land` lands one, with the gates, where a landing hold is merged by hand. */
  heldResolutions?: string[];
  keptWorktrees: { issue: string; path: string }[];
  /**
   * Every other worktree left under `.sandcastle/worktrees/`, from any earlier run: `merged` is `clean`'s own rule for its branch
   * (nothing on it that the base lacks), `kb` its disk use when it could be read. A live run's own tickets are left out: in flight, not kept.
   */
  earlierKept?: { path: string; issue?: string; merged: boolean; kb?: number }[];
  /** Tracked files a gate rewrote and the kit put back. */
  gateRewrites?: string[];
  dryRunCheck?: string;
  /** Why the run stopped before landing, if it did. */
  stopped?: string;
  /** The stop's cause in a few words, when it was the `.git` guard's: tells a moved base from any other change. */
  stoppedWhat?: string;
  /** The prompt-expansion error that crashed tickets alike, so the run started no more: a setup problem, not the tickets'. */
  setupProblem?: string;
  /** The reason the follow-ups were withheld from the tracker, said once for the set. */
  followUpsWithheld?: string;
  /** How a person ended the run (`sandcastle stop`, Ctrl-C, a signal): not a crash, though its exit code is not 0. */
  stoppedBy?: string;
  /** Files changed per held branch. */
  changed: Record<string, number>;
  /** Held tickets whose branch a person has merged by hand: on the base, the ticket still open until the push. */
  mergedByHand?: string[];
  /** The part of `mergedByHand` whose ticket is already closed (the hand merge was pushed): nothing is left to close on push. */
  mergedByHandClosed?: string[];
  /** The part of `mergedByHand` merged as "part of" its ticket (a criterion left unmet): still open after the push, by design. */
  mergedByHandPartly?: string[];
  /** Held tickets whose branch is gone (`sandcastle clean`) with no merge of it on the base: nothing to review, and no merge command that would work. */
  branchGone?: string[];
  /** Issues opened during the run (by anyone: agents share the person's `gh` token), carrying the triage label and still open (GitHub only). */
  filed?: { id: string; title: string }[];
  /** What the agents' `<followup>` lines became (the run record's `followUps`): filed for triage, or only listed in a dry run. */
  followUps?: FiledFollowUp[];
  /** The run record's last stage and exit code: "base gates" with a non-zero exit is a run that never started anything. */
  stage?: string;
  exitCode?: number | null;
  /** Each base gate's verdict, when the run stopped on red base gates. */
  baseGates?: { gate: string; ok: boolean }[];
  /** Tests found red on the base mid-run (the run record's `baseRed`): no branch was repaired for them. */
  baseRed?: string[];
  /** The run record's `mergeUnchecked`: a host merge check that could not run for objects a partial clone lacks. */
  mergeUnchecked?: string;
  /** The run settings the last turn's record carries; absent from an older kit's record. */
  settings?: RunSettings;
  /** The Claude plan usage the last record holds (`usage`), when the run spent a subscription on a Claude model: the last reading, or none yet. */
  usage?: PlanUsage;
  /** The Codex plan usage the last record holds, when the run's cross-review spent a ChatGPT plan: the last reading, or none yet. */
  codexUsage?: PlanUsage;
  /** What the earlier turns of the same `sandcastle run` left, oldest first: each turn's facts, cut to the tickets no later turn attempted (`gather` fills it from history.jsonl). */
  carried?: { turn: number; facts: Facts }[];
  /** Set when the autonomy loop runs another turn straight after this one: nothing here is the operator's to do yet. */
  next?: { level: Level; turn: number; tickets: string[] };
};

/**
 * The paths of a diff that left its `Touches:` line, as the close comment and the closing report
 * both list them. Test files only follow a refactor (a renamed import), and docs are what the repo's
 * rules have every change edit (README, architecture notes, the skill), so each folds into a count
 * ("+7 test files", "+2 docs files"). The paths that stay listed are the source files a ticket's
 * line missed - the overrun worth reading. The run record keeps every path; only this line folds them.
 */
export const overrunPaths = (paths: string[]) => {
  const tests = paths.filter(isTestPath).length;
  const docs = paths.filter((p) => !isTestPath(p) && isDocPath(p)).length;
  const listed = paths.filter((p) => !isTestPath(p) && !isDocPath(p));
  const count = (n: number, what: string) => (n ? [`+${n} ${what} file${n === 1 ? "" : "s"}`] : []);
  return [...listed, ...count(tests, "test"), ...count(docs, "docs")].join(", ");
};

/**
 * Whether an overrun is worth a note: some path is a source file. An overrun of only test and docs
 * files is the usual follow-through of a change (`overrunPaths` folds them), so it stays in the run
 * record and neither the close comment nor the report says it.
 */
export const overrunNoted = (paths: readonly string[] | undefined) => !!paths?.some((p) => !isTestPath(p) && !isDocPath(p));

/** The close comment's paragraph for a diff that left its `Touches:` line. */
export const overrunLine = (paths: string[]) => `changed beyond its Touches line: ${overrunPaths(paths)}`;

/**
 * The report's own sections, finer than the status view's groups: where a ticket's part in a run
 * ends. `needs fixing`, `settled` and `left` are where it ends; `working` is a ticket the run stopped
 * mid-work ("ready" outside a dry run too). Keyed by the closed set: a new ticket state must be placed.
 */
type Section = "needs fixing" | "settled" | "left" | "working";
const SECTIONS: Record<TicketState, Section> = {
  red: "needs fixing",
  conflict: "needs fixing",
  crashed: "needs fixing",
  "not landed": "needs fixing",
  blocked: "left",
  skipped: "left",
  merged: "settled",
  nochange: "settled",
  uncommitted: "settled",
  withdrawn: "settled",
  stopped: "settled",
  held: "settled",
  queued: "settled",
  setup: "working",
  implement: "working",
  resolve: "working",
  review: "working",
  "cross-review": "working",
  gates: "working",
  repair: "working",
  ready: "working",
  landing: "working",
  paused: "working",
};
const statesIn = (section: Section) => TICKET_STATES.filter((s) => SECTIONS[s] === section);
/** A state outside the set is in no section: a record of an older kit is not the person's to fix, nor a ticket cut short. */
const sectionOf = (state: string | undefined) => (isTicketState(state) ? SECTIONS[state] : undefined);
export const NEEDS_FIXING = statesIn("needs fixing");
const LEFT = statesIn("left");
// A ticket the landing worker found green alone and red once merged has the outcome `red`; a red gate
// in its own pipeline has `gate red`. The difference is the pair, not the gate.
const redTogether = (f: Facts, id: string) => f.tickets[id]?.state === "red" && f.outcomes?.[id] === "red";

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

/**
 * The worktrees under `.sandcastle/worktrees/` that this run's record does not list as kept: an earlier run's, which the
 * run's own `keptWorktrees` never reaches and which pile up (about a GB each). A live run's tickets are in flight, so their
 * worktrees (and the scratch ones of a base gate or a landing) are not kept yet and are left out.
 */
const earlierKeptWorktrees = (project: Project, run: any, tickets: Record<string, TicketRecord>, live: boolean): NonNullable<Facts["earlierKept"]> => {
  const root = project.root;
  let entries: ReturnType<typeof projectWorktrees>;
  try {
    entries = projectWorktrees(project);
  } catch {
    return [];
  }
  const mine = new Set((Array.isArray(run.keptWorktrees) ? run.keptWorktrees : []).map((k: { path?: unknown }) => resolve(root, String(k?.path ?? ""))));
  const found: NonNullable<Facts["earlierKept"]> = [];
  for (const { path, branch } of entries) {
    if (mine.has(resolve(root, path)) || !existsSync(path)) continue;
    const issue = /^agent-issue-(.+)$/.exec(basename(path))?.[1];
    if (live && (!issue || issue in tickets || branch?.startsWith("sandcastle/"))) continue;
    let merged = false;
    try {
      merged = !!branch && branchFinished(project, branch);
    } catch {
      /* a branch git cannot compare is not said to be merged */
    }
    // `du -sk` reads the same on macOS and Linux; a tree that cannot be read has no figure.
    const kb = duKb(path);
    found.push({ path, ...(issue ? { issue } : {}), merged, ...(Number.isFinite(kb) ? { kb } : {}) });
  }
  return found;
};

const GB_KB = 1024 * 1024;
/** The disk use of the earlier kept worktrees, said only from 1 GB up: below that it is not why anyone cleans. */
const sizeWords = (kept: NonNullable<Facts["earlierKept"]>) => {
  const kb = kept.reduce((sum, k) => sum + (k.kb ?? 0), 0);
  return kb >= GB_KB ? ` (${kb >= 10 * GB_KB ? Math.round(kb / GB_KB) : (kb / GB_KB).toFixed(1)} GB on disk)` : "";
};

const earlierKeptLines = (f: Facts): string[] => {
  const kept = f.earlierKept ?? [];
  if (!kept.length) return [];
  const merged = kept.filter((k) => k.merged).length;
  const open = kept.length - merged;
  const n = (c: number) => `${c} worktree${c === 1 ? "" : "s"}`;
  return [`Worktrees kept by earlier runs: ${n(kept.length)}${sizeWords(kept)} - ${merged} merged, ${open} with work not on ${f.base}`];
};

const duKb = (path: string) => {
  try {
    return Number(sh("du", ["-sk", path]).split(/\s/)[0]);
  } catch {
    return NaN;
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

/** The phases of a ticket's timings lines that are a pass of it: its sandbox's setup is not one. */
export const PASS_PHASES = ["implement", "resolve", "review", "cross-review", "gates", "repair", LANDING_GATES] as const;

/** One pass of a ticket as its timings line has it: `ms` without the slot wait, and the gates a red gate run named. */
export type TicketPass = { phase: (typeof PASS_PHASES)[number]; ms: number; ok: boolean; red?: string[] };

/**
 * One ticket's passes in one run from timings.jsonl text, in the order they ended: the run given (the
 * run record's `startedAt`), else the latest run whose lines name the ticket. The ticket card reads it
 * on a click, so it takes the text and nothing else: no git, no tracker.
 */
export const ticketPasses = (text: string, id: string, runId?: string): TicketPass[] => {
  const lines: { run: string; pass: TicketPass }[] = [];
  for (const raw of text.split("\n")) {
    let line: { run?: unknown; issue?: unknown; phase?: unknown; ms?: unknown; ok?: unknown; red?: unknown };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!line || typeof line.run !== "string" || line.issue !== id || !(PASS_PHASES as readonly unknown[]).includes(line.phase)) continue;
    const red = Array.isArray(line.red) ? line.red.filter((r): r is string => typeof r === "string") : [];
    lines.push({
      run: line.run,
      pass: { phase: line.phase as TicketPass["phase"], ms: typeof line.ms === "number" ? line.ms : 0, ok: line.ok === true, ...(red.length ? { red } : {}) },
    });
  }
  const run = runId ?? lines.at(-1)?.run;
  return lines.filter((l) => l.run === run).map((l) => l.pass);
};

type Opened = { number: number; title: string; createdAt: string };

/**
 * One turn's facts from its record. `earlier` marks a finished turn read back from history to be carried into
 * the last turn's summary: only what a person owes is gathered (not the blockers, the branches standing, the
 * tokens or the plan usage, which are the last turn's to say), and `earlier.until` closes the window of issues
 * opened during it when the record has no end of its own.
 */
const gatherTurn = async (project: Project, run: any, probe: Probe, opened: Opened[], earlier?: { until: string }): Promise<Facts> => {
  const root = project.root;
  const base = project.baseBranch;
  const tickets = readTickets(run);
  // The asking process itself is neither another live run nor a killed one: it is summing itself
  // up, before its exit writes the end.
  const alive = earlier ? { state: "finished" as const } : liveness({ record: run, self: process.pid }, probe);
  const live = alive.state === "live";

  // Blockers read again now: this run's own merges close some of them, and a
  // list from the start of the run said "blocked" for issues ready to go.
  const runnable: string[] = [];
  const blocked: Facts["blocked"] = [];
  let blockCheck: string | undefined;
  const waiting = earlier ? [] : Object.entries(tickets).filter(([, t]) => t.state === "blocked").map(([id]) => id);
  if (waiting.length) {
    try {
      // One list of the open tickets answers every ticket and blocker in it; a read per one took a minute with dozens blocked.
      const { tracker, listed } = withOpenList(project, makeTracker(project));
      const resolve = blockerResolver(project, tracker, listed);
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

  // A partly-done ticket is merged and open; it runs again only while it is still in the queue.
  let partial: string[] | undefined;
  const partlyDone = Object.entries(tickets).filter(([, t]) => t.state === "merged" && t.unmet).map(([id]) => id);
  if (partlyDone.length) {
    try {
      const queued = new Set(makeTracker(project).queued(false).map((t) => t.id));
      partial = partlyDone.filter((id) => queued.has(id));
    } catch {
      partial = undefined;
    }
  }

  const upstream = earlier ? undefined : git(["rev-parse", "--abbrev-ref", `${base}@{upstream}`], root);
  const ahead = upstream ? Number(git(["rev-list", "--count", `${upstream}..${base}`], root) ?? NaN) : undefined;
  const standing = earlier
    ? []
    : (git(["branch", "--format=%(refname:short)", "--list", "agent/*"], root) ?? "")
        .split("\n")
        .filter((b) => b && (git(["cherry", base, b], root) ?? "").split("\n").some((l) => l.startsWith("+")));
  const changed: Record<string, number> = {};
  for (const [id, t] of Object.entries(tickets)) {
    if (t.state !== "held") continue;
    const files = git(["diff", "--name-only", `${base}...agent/issue-${id}`], root);
    if (files !== undefined) changed[id] = files.split("\n").filter(Boolean).length;
  }
  // A branch with no ref has no diff: `clean` deletes one once its patches are on the base, so the merge's subject says whether it was merged.
  const gone = Object.entries(tickets).filter(([id, t]) => t.state === "held" && changed[id] === undefined).map(([id]) => id);
  // A finished ticket the run stopped before landing, which `sandcastle land` then merged: the run record still says `stopped`.
  const landedAfterStop = Object.entries(tickets).filter(([, t]) => t.state === "stopped").map(([id]) => id);
  const byHand = [...Object.keys(changed).filter((id) => changed[id] === 0), ...gone, ...landedAfterStop].filter((id) => mergedByHand(root, base, id));
  // An agent that handed a ticket back left no commits, so `clean` deletes its branch too: the question is still the person's to answer.
  const recorded = readOutcomes(root);
  for (const id of gone) {
    const o = recorded[id];
    if (o?.run === run.startedAt && (o.text === HANDED_BACK || o.kind === "no change")) changed[id] = 0;
  }
  const branchGone = gone.filter((id) => !byHand.includes(id) && changed[id] === undefined);
  let byHandClosed: string[] = [];
  if (byHand.length) {
    try {
      const tracker = makeTracker(project);
      byHandClosed = byHand.filter((id) => tracker.isClosed(id) === true);
    } catch {
      byHandClosed = [];
    }
  }
  // A "part of" merge never closes its ticket, so "closes on push" would be wrong for it. The criterion it left
  // undone is in the run record, or else in the head record the hand merge was judged on.
  const byHandPartly = byHand.filter((id) => !byHandClosed.includes(id) && mergedPartly(root, base, id));
  for (const id of byHandPartly) tickets[id].unmet ||= readHeads(root)[id]?.unmet;

  // Issues opened during the run: open, carrying the triage label, created between its start
  // and its end. Agents file with the person's own token, so the author cannot say who opened
  // one; the report says "opened", never "filed by an agent". A run still going has no end yet
  // (each autonomy turn writes a finishedAt and the run goes on), and one that is only now
  // summing itself up has not written its own, so the window closes only for a finished run:
  // otherwise `sandcastle report` would list whatever a person opens afterwards, every time.
  // Dates are compared here, not with a shell `date`, which differs on macOS.
  // The issues are listed once for the run's turns (`gather`); each turn takes those opened in its own window.
  const from = Date.parse(run.startedAt);
  const to = earlier ? Date.parse(run.finishedAt ?? earlier.until) : alive.state === "finished" && run.finishedAt ? Date.parse(run.finishedAt) : Infinity;
  const filed = opened.filter((i) => Date.parse(i.createdAt) >= from && Date.parse(i.createdAt) <= to).map((i) => ({ id: String(i.number), title: i.title }));

  // The record is a file in a repository: an entry without a title and a source says nothing.
  const followUps: FiledFollowUp[] = (Array.isArray(run.followUps) ? run.followUps : []).filter(
    (u: unknown): u is FiledFollowUp => !!u && typeof (u as FiledFollowUp).title === "string" && typeof (u as FiledFollowUp).from === "string" && typeof (u as FiledFollowUp).phase === "string",
  );

  // Only this run's: an entry an earlier run wrote says nothing about this run's tickets.
  const outcomes = Object.fromEntries(
    Object.entries(readOutcomes(root)).flatMap(([id, o]) => (o.run === run.startedAt && o.kind ? [[id, o.kind]] : [])),
  );

  // Said beside the branch: the reader of this summary would otherwise have to remember the earlier run, or read outcomes.json.
  // A landing hold's text is the same constant for every cause, so its reason is read from that run's own record in history.
  const earlierHeld = Object.fromEntries(
    standing.flatMap((b) => {
      const id = b.replace(/^agent\/issue-/, "");
      const o = recorded[id];
      if (o?.kind !== "held" || o.run === run.startedAt) return [];
      return [[b, o.text === LANDING_HOLD ? (heldReasonIn(root, o.run, id) ?? LANDING_HOLD) : (o.text ?? "")]];
    }),
  );

  // Matched by its own wording (`needs a human: conflict resolution changed ...`, what `heldResolution` records; the files after it vary, so no whole-line compare): a hold in any other
  // words (an older kit's, a protected path's) keeps the hand merge, which `sandcastle land` would refuse or skip the review of.
  const heldResolutions = Object.entries(recorded).filter(([, o]) => o.kind === "held" && o.text?.includes(STRAY_NOTE_START)).map(([id]) => id);

  const timingsFile = join(root, ".sandcastle/logs/timings.jsonl");
  const timed = !earlier && existsSync(timingsFile) ? tokensFromTimings(readFileSync(timingsFile, "utf8"), run.startedAt) : undefined;

  return {
    base,
    tracker: project.tracker.kind,
    started: run.startedAt,
    finished: run.finishedAt,
    live,
    ...(live && typeof run.paused?.since === "number" ? { paused: { since: run.paused.since } } : {}),
    killed: alive.state === "dead",
    dryRun: !!run.dryRun,
    tokens: run.tokens,
    tokenTotal: timed?.total,
    byModel: timed?.byModel,
    verify: run.verify,
    gateCount: project.gates.length,
    tickets,
    outcomes,
    runnable,
    partial,
    holdLabel: project.tracker.held,
    blocked,
    blockCheck,
    ahead: Number.isNaN(ahead) ? undefined : ahead,
    upstream,
    standing,
    earlierHeld,
    heldResolutions,
    keptWorktrees: run.keptWorktrees ?? [],
    earlierKept: earlier ? undefined : earlierKeptWorktrees(project, run, tickets, live),
    gateRewrites: run.gateRewrites,
    dryRunCheck: run.dryRunCheck,
    stopped: run.stopped,
    stoppedWhat: run.stoppedWhat,
    setupProblem: run.setupProblem,
    followUpsWithheld: run.followUpsWithheld,
    stoppedBy: run.stoppedBy,
    changed,
    mergedByHand: byHand,
    mergedByHandClosed: byHandClosed,
    mergedByHandPartly: byHandPartly,
    branchGone,
    // The kit's own filings are listed as follow-ups, with their source: not again as issues someone opened.
    filed: filed.filter((i) => !followUps.some((u) => u.id === i.id)),
    followUps,
    stage: run.stage,
    exitCode: run.exitCode,
    baseGates: run.baseGates,
    baseRed: Array.isArray(run.baseRed) ? run.baseRed.filter((t: unknown): t is string => typeof t === "string") : undefined,
    mergeUnchecked: typeof run.mergeUnchecked === "string" ? run.mergeUnchecked : undefined,
    settings: run.settings && typeof run.settings === "object" ? run.settings : undefined,
    usage: earlier ? undefined : readPlanUsages(run.usage).find((u) => u.provider === "claude"),
    codexUsage: earlier ? undefined : readPlanUsages(run.usage).find((u) => u.provider === "codex"),
  };
};

/** Open issues carrying the triage label, with their creation times (GitHub only; an unreadable list is none). */
const openedIssues = (project: Project): Opened[] => {
  if (project.tracker.kind !== "github") return [];
  try {
    const list = JSON.parse(sh("gh", ["issue", "list", "--state", "open", "--label", project.tracker.triage, "--limit", "500", "--json", "number,title,createdAt"], project.root));
    return Array.isArray(list) ? (list as Opened[]) : [];
  } catch {
    return [];
  }
};

/**
 * Why an earlier run held ticket `id` for a human merge, from that run's line in history.jsonl (the one whose `startedAt` is
 * `startedAt`): the protected paths or files its note and `files` name, and the criterion it left `unmet`. Undefined when
 * history has no such line or the line says nothing more than the hold itself.
 */
const heldReasonIn = (root: string, startedAt: string | undefined, id: string): string | undefined => {
  const file = join(root, ".sandcastle/logs/history.jsonl");
  if (!startedAt || !existsSync(file)) return undefined;
  for (const text of readFileSync(file, "utf8").split("\n").reverse()) {
    if (!text) continue;
    const record = parseRecord(text);
    if (record?.startedAt !== startedAt) continue;
    const t = readTickets(record)[id];
    if (!t) return undefined;
    // The note of a protected-path hold starts with the hold's own words, which the line already says.
    const note = (t.note ?? "").replace(/^(dry run: would hold|human merge): /, "").trim();
    const files = (Array.isArray(t.files) ? t.files : []).filter((f) => !note.includes(f));
    const parts = [note, files.join(", "), t.unmet ? `unmet: ${t.unmet}` : ""].filter(Boolean);
    return parts.length ? parts.join("; ") : undefined;
  }
  return undefined;
};

/**
 * The earlier turns of the run `run` is a turn of, oldest first, from the end of history.jsonl: the lines of
 * the same process and project whose `settings.turn` counts down from this turn - 1 to 1, stopping at the first
 * line that does not. The copy of this turn's own record a finished turn leaves in history is skipped. A turn
 * 1, or a record with no `settings.turn` (an older kit), has none.
 */
const earlierTurns = (root: string, run: any): any[] => {
  const turn = run.settings?.turn;
  const file = join(root, ".sandcastle/logs/history.jsonl");
  if (!Number.isInteger(turn) || turn < 2 || !existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).reverse();
  const found: any[] = [];
  for (const text of lines) {
    const record = parseRecord(text) as any;
    if (record?.startedAt === run.startedAt) continue;
    if (!record || record.pid !== run.pid || record.orchestrator !== run.orchestrator || record.settings?.turn !== turn - 1 - found.length) break;
    found.unshift(record);
    if (found.length === turn - 1) break;
  }
  // A chain that stops short of turn 1 is not this run's: a line of another run could have the right number.
  return found.length === turn - 1 ? found : [];
};

/** Whether a later turn's record of a ticket is an attempt at it: not still waiting, and not a ticket put back in the queue unstarted. */
const attemptedIn = (t: TicketRecord) => sectionOf(t.state) !== undefined && !LEFT.includes(t.state!) && !(t.state === "queued" && !t.requeued);

/** The kept worktrees of an earlier turn's tickets that stand in its facts: a ticket a later turn ran again was cut from them. */
const carriedKept = (facts: Facts) => facts.keptWorktrees.filter((k) => k.issue in facts.tickets);

/**
 * What the earlier turns of this run left, each turn's facts cut to the tickets no later turn attempted (a
 * later ending replaces an earlier one), and a partly done ticket closed since dropped.
 */
const carriedTurns = async (project: Project, run: any, probe: Probe, opened: Opened[]): Promise<NonNullable<Facts["carried"]>> => {
  const turns = earlierTurns(project.root, run);
  const carried: NonNullable<Facts["carried"]> = [];
  let tracker: ReturnType<typeof makeTracker> | undefined;
  for (const [i, record] of turns.entries()) {
    const replaced = new Set([...turns.slice(i + 1), run].flatMap((later) => Object.entries(readTickets(later)).filter(([, t]) => attemptedIn(t)).map(([id]) => id)));
    const kept = Object.fromEntries(Object.entries(readTickets(record)).filter(([id]) => !replaced.has(id)));
    const until = (turns[i + 1] ?? run).startedAt;
    const facts = await gatherTurn(project, { ...record, tickets: kept }, probe, opened, { until });
    // Still open: a remainder a person closed since is done. An unreadable tracker keeps it, as a person should look.
    for (const [id, t] of Object.entries(facts.tickets)) {
      if (t.state !== "merged" || !t.unmet) continue;
      try {
        tracker ??= makeTracker(project);
        if (!tracker.get(id).open) delete facts.tickets[id];
      } catch {
        /* keep it */
      }
    }
    carried.push({ turn: record.settings.turn, facts });
  }
  return carried;
};

/** `probe` is the process check (src/live-runs.ts `commandOf`); a test passes its own. */
export const gather = async (project: Project, probe: Probe = commandOf): Promise<Facts> => {
  const run = JSON.parse(readFileSync(join(project.root, ".sandcastle/logs/run.json"), "utf8"));
  const opened = openedIssues(project);
  const facts = await gatherTurn(project, run, probe, opened);
  const carried = await carriedTurns(project, run, probe, opened);
  if (!carried.length) return facts;
  // A branch an earlier turn held is said with its turn: not again as held "in an earlier run", with a second step.
  const heldBefore = new Set(carried.flatMap((c) => Object.entries(c.facts.tickets).filter(([, t]) => t.state === "held").map(([id]) => `agent/issue-${id}`)));
  const earlierHeld = Object.fromEntries(Object.entries(facts.earlierHeld ?? {}).filter(([b]) => !heldBefore.has(b)));
  // A worktree an earlier turn kept is named under its turn: not counted again among the earlier runs'.
  const named = new Set(carried.flatMap((c) => carriedKept(c.facts).map((k) => resolve(project.root, k.path))));
  const earlierKept = facts.earlierKept?.filter((k) => !named.has(resolve(project.root, k.path)));
  return { ...facts, earlierHeld, earlierKept, carried };
};

const LEVELS = [0, 1, 2, 3, "drain"];
const API_CREDITS = "billing API credits (ANTHROPIC_API_KEY)";

/**
 * The run's settings as one line, and the hints its own facts call for. Only a field the record
 * holds is said, and a value of the wrong type is as unknown as a missing one: the record is a
 * file in a repository. A hint is a switch that would have changed this run's outcome, never a
 * catalogue: nothing here is said when nothing calls for it.
 */
export const settingsLines = (f: Facts, bare = false): string[] => {
  const s = f.settings;
  // The plan's usage, as the last agent reported it: a fact of the run, so it stands with or without a settings group. Under an API key there is none.
  const w = f.usage?.windows;
  const when = f.live ? "so far" : "at the end";
  const usage = w ? [`Plan usage ${when}: 5h ${w.fiveHour.percent}%, week ${w.week.percent}%`] : [];
  // A cross-review run's Codex plan, beside Claude's: the two are different accounts, so each has its own line.
  const cw = f.codexUsage?.windows;
  if (cw) usage.push(`Codex plan usage ${when}: 5h ${cw.fiveHour.percent}%, week ${cw.week.percent}%`);
  if (!s || typeof s !== "object") return usage;
  const count = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined);
  const plain = (v: unknown, pattern: RegExp) => (typeof v === "string" && pattern.test(v) ? v : undefined);
  const level = LEVELS.includes(s.autonomy as never) ? s.autonomy : undefined;
  const turn = count(s.turn);
  const cap = count(s.cap);
  const stop = count(s.usageStop);
  const items: string[] = [];
  if (level !== undefined) items.push(`autonomy ${level}${turn ? ` (turn ${turn}${cap ? ` of ${cap}` : ""})` : ""}`);
  if (s.crossReview === true) {
    const model = plain(s.crossReviewModel, /^[A-Za-z0-9._:/-]+$/);
    const effort = plain(s.crossReviewEffort, /^(low|medium|high|xhigh)$/);
    items.push(`cross-review on${model ? ` (${model}${effort ? ` ${effort}` : ""})` : ""}`);
  } else if (s.crossReview === false) items.push("cross-review off");
  const noReading = s.usageGuard === true && s.usageReading === "unavailable";
  if (s.usageGuard === true) items.push(`usage guard on${stop !== undefined ? `, stops at ${stop}%` : ""}${noReading ? ", no reading" : ""}`);
  else if (s.usageGuard === false) items.push("usage guard off");
  const pause = count(s.usagePause);
  if (pause !== undefined) items.push(`usage pause at ${pause}%`);
  // Never silent: red where colour is wanted, and the words say it where it is not.
  if (s.apiKey === true) items.push(bare ? API_CREDITS : red(API_CREDITS));
  if (!items.length) return usage;

  const lines = [`Settings: ${items.join(" · ")}`, ...usage];
  const again = level === 0 && !f.next ? rerunnable(f) : undefined;
  const left = again ? [...new Set([...again.conflicted, ...again.unblocked, ...(again.partial ?? [])])] : [];
  if (left.length) {
    lines.push(
      `Autonomy 0 makes one turn, and ${left.map(refOf).join(" ")} could run again: \`AUTONOMY_LEVEL=2\` (or \`drain\`) lets one \`sandcastle run\` take ` +
        `${left.length === 1 ? "it" : "them"} without starting it by hand.`,
    );
  }
  if (noReading) lines.push("The usage guard had no reading, so this run was not guarded: check your usage yourself.");
  return lines;
};

/**
 * The line for a run the plan's session or weekly limit stopped: the skipped tickets whose note names it say when it
 * resets, and a run with `USAGE_PAUSE` off is told the switch that waits the window out. Nothing for any other stop.
 */
const planLimitLines = (f: Facts, skipped: string[]): string[] => {
  const notes = skipped.map((id) => f.tickets[id]?.note ?? "").filter((n) => /usage limit/i.test(n));
  if (!notes.length) return [];
  const resets = notes.map((n) => /\(resets (.+)\)$/.exec(n)?.[1]).find((r) => r !== undefined);
  const off = typeof f.settings?.usagePause !== "number";
  return [
    `Paused for usage: the plan's limit stopped the run${resets ? `, resets ${resets}` : ""}; the tickets above are runnable again once the window resets.` +
      (off ? " `USAGE_PAUSE=95` (a percentage, 1 to 100) makes a run wait out the window and carry on." : ""),
  ];
};

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const span = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/**
 * The suggested changelog lines as the closing summary and `report --changelog` print them: a line
 * starting with none of the three words is a Changed. An `Upgrading:` line is what an existing
 * project must act on: it is listed apart, never among the changes.
 */
const changelogLines = (all: { id: string; line: string }[]): string[] => {
  const out: string[] = [];
  const isUpgrading = ({ line }: { line: string }) => line.startsWith("Upgrading:");
  const lines = all.filter((l) => !isUpgrading(l));
  const upgrading = all.filter(isUpgrading);
  if (lines.length) {
    out.push("Changelog lines the agents suggested:");
    for (const group of ["Added", "Changed", "Fixed"]) {
      const mine = lines.filter(({ line }) => (/^(Added|Changed|Fixed):/.exec(line)?.[1] ?? "Changed") === group);
      for (const { id, line } of mine) out.push(`  ${group}: ${line.replace(/^(Added|Changed|Fixed):\s*/, "")} (${refOf(id)})`);
    }
  }
  if (upgrading.length) {
    out.push("Upgrading notes the agents suggested - an existing project must act on these, so write them under Upgrading, not as changes:");
    for (const { id, line } of upgrading) out.push(`  Upgrading: ${line.replace(/^Upgrading:\s*/, "")} (${refOf(id)})`);
  }
  return out;
};

/**
 * The verify's line when it did not run: the green-base record already named the merged tip, so the gates that proved
 * it are the ones to name - a landing's, merged in a sandbox (`gated with #427 in its landing sandbox`), or the base
 * check's or an earlier verify's (`gated by ...`). Only gate-only sandboxes are such a proof (`greenProofOfBase`).
 * `image` (` on image <tag>`) goes with the green, not after "not run again": those gates ran on it.
 */
export const verifySkippedLine = (base: string, proof: { commit: string; by?: string; kind?: string }, image = "") => {
  const by = typeof proof.by === "string" && proof.by ? proof.by : "";
  // "In its landing sandbox" only on that kind: a record from before kinds (a fast-forward's, say) names a ticket too.
  const said = by ? `gated ${by.startsWith("#") ? "with" : "by"} ${by}${proof.kind === "landing-sandbox" ? " in its landing sandbox" : ""}` : "gated before";
  return `Merged ${base} re-gated: green at ${String(proof.commit).slice(0, 7)} already${image} (${said}) - not run again`;
};

const nameOf = (f: Facts, id: string) => `${refOf(id)}${f.tickets[id]?.title ? ` ${f.tickets[id].title}` : ""}`;
const listOf = (xs: string[]) => xs.map(refOf).join(" ") || "none";

/**
 * Where each ticket of a turn stands with a person, as the Needs you section and its Next steps read it.
 * Both the last turn and each carried one (`Facts.carried`) go through it, so a held branch is worded alike.
 */
const owed = (f: Facts) => {
  const ids = (states: TicketState[]) => Object.entries(f.tickets).filter(([, t]) => !!t.state && states.includes(t.state)).map(([id]) => id);
  const merged = ids(["merged"]);
  // Merged, but the tracker refused the close: the work is on base, the ticket still open.
  const notClosed = merged.filter((id) => f.tickets[id].closeFailed);
  // Merged with an acceptance criterion knowingly left undone: the ticket was left open on purpose.
  const partly = merged.filter((id) => f.tickets[id].unmet);
  const closed = merged.filter((id) => !notClosed.includes(id) && !partly.includes(id));
  // What the next run does with each remainder, as the autonomy loop reads it (`partialRerunnable`): an agent
  // runs it again while the ticket is queued, unless its own note says the remainder needs a person.
  const partlyRerun = partialRerunnable(f);
  const partlyDecide = partly.filter((id) => needsDecision(f.tickets[id].unmet!));
  // Still open but out of the queue (a person held or unlabelled it): no run takes it. Unknown when the queue was unreadable.
  const partlyAway = f.partial ? partly.filter((id) => !f.partial!.includes(id) && !partlyDecide.includes(id)) : [];
  // Merged with green gates, but the reviewer said no gate exercises the change. Only merged
  // tickets: a held or red one is already in front of a person, and a dry run merges nothing.
  const ungated = merged.filter((id) => f.tickets[id].ungated);
  // Likewise merged, with a gap a reviewer named in prose and filed nowhere (no `<followup>`, no `<unmet>`).
  const gapped = merged.filter((id) => f.tickets[id].gap);
  // Held work a person has merged by hand: on the base already, so not theirs to merge or redo; the push closes it.
  const byHand = ids(["held", "stopped"]).filter((id) => f.mergedByHand?.includes(id));
  const held = ids(["held"]).filter((id) => !byHand.includes(id));
  // Held, its branch cleaned away and never merged: only the ticket is left to act on.
  const gone = held.filter((id) => f.branchGone?.includes(id));
  // Held with nothing on its branch: an agent handed it back, or a person took
  // it before any commit. There is nothing to review or merge - only a question.
  const handedBack = held.filter((id) => f.changed[id] === 0 && !gone.includes(id));
  // Marked for a human by a person mid-run: they took it; the branch is only there if it helps.
  const takenBack = held.filter((id) => !handedBack.includes(id) && f.outcomes?.[id] === "taken back");
  const heldWork = held.filter((id) => !handedBack.includes(id) && !takenBack.includes(id) && !gone.includes(id));
  // Finished, but the commit was refused: the work sits in a kept worktree.
  const uncommitted = ids(["uncommitted"]);
  // The follow-ups, split the way their lines under Needs you are: filed, whose filing failed (a person files it by
  // hand, so it needs them), and not filed yet - a dry run's, which a real run would file, or those of a run that
  // ended before its filing. The last are counted to triage with the filed ones: they are what a real run leaves there.
  const followUps = f.followUps ?? [];
  // Unfiled in a real run (a failed filing, or a stop after which the kit writes nothing more to the tracker) is
  // a person's to file; unfiled in a dry run is what a real run would leave for triage.
  const filingFailed = followUps.filter((u) => !u.id && (u.failed || !f.dryRun)).length;
  const toTriage = (f.filed ?? []).length + followUps.filter((u) => u.id || (!u.failed && f.dryRun)).length;
  return { ids, merged, notClosed, partly, closed, partlyRerun, partlyDecide, partlyAway, ungated, gapped, byHand, held, gone, handedBack, takenBack, heldWork, uncommitted, followUps, filingFailed, toTriage };
};
type Owed = ReturnType<typeof owed>;

/** One follow-up as a Needs you bullet: filed for triage, whose filing failed, or not filed yet. */
const followUpLine = (f: Facts, u: FiledFollowUp) => {
  const from = `from ${refOf(u.from)} (${u.phase})`;
  return u.id
    ? `- ${refOf(u.id)} ${u.title} - filed for triage ${from}: triage it, then queue or close it`
    : u.failed
      ? `- ${u.title} - ${from}: filing it for triage failed (${u.failed}) - file it by hand`
      : f.dryRun
        ? `- ${u.title} - ${from}: a real run files it for triage`
        : `- ${u.title} - ${from}: not filed, as the run stopped before it could - file it by hand`;
};

/**
 * The follow-ups a person files by hand, as Needs you lines. Those the run withheld from the tracker (`followUpsWithheld`:
 * a `.git` stop) share one reason, said once on a line of its own over their bullets - nine repeats of it were nine lines
 * of noise - and `turn` marks that line the way `fromTurn` marks a bullet.
 */
const byHandLines = (f: Facts, us: FiledFollowUp[], turn?: number): string[] => {
  const withheld = (u: FiledFollowUp) => f.followUpsWithheld !== undefined && !u.id && u.failed === f.followUpsWithheld;
  const held = us.filter(withheld);
  return [
    ...us.filter((u) => !withheld(u)).map((u) => followUpLine(f, u)),
    ...(held.length ? [`Follow-ups not filed - ${f.followUpsWithheld}${turn ? ` (turn ${turn})` : ""}; file each by hand:`] : []),
    ...held.map((u) => `- ${u.title} - from ${refOf(u.from)} (${u.phase})`),
  ];
};

/**
 * The Needs you bullets of a turn's tickets: a held branch, a refused commit, a partly done remainder, a check by
 * hand, a gap. A carried turn (`carried`) leaves out a close that failed (the next run closes it): no run re-runs
 * an uncommitted ticket, so its refused commit is said for an earlier turn too.
 */
const ticketLines = (f: Facts, o: Owed, carried: boolean): string[] => {
  const name = (id: string) => nameOf(f, id);
  const holdLabel = f.holdLabel ? ` (\`${f.holdLabel}\`)` : "";
  const keptAt = (id: string) => f.keptWorktrees.find((k) => k.issue === id)?.path ?? f.tickets[id].note?.replace(/^work left uncommitted in /, "") ?? "its kept worktree";
  return [
    ...o.uncommitted.map(
      (id) =>
        `- ${name(id)} - finished but not committed - the work is in ${keptAt(id)}. Fix what refused the commit (the agent's comment says), then \`sandcastle requeue <ticket>\`: the next run reuses that worktree. Or commit it there yourself.`,
    ),
    ...o.heldWork.flatMap((id) => {
      const t = f.tickets[id];
      const size = f.changed[id] !== undefined ? ` - ${f.changed[id]} file(s)` : "";
      const why = t.files?.length ? `changes ${t.files.join(", ")}` : (t.note ?? "held");
      // A criterion the agents left undone travels with the branch: whoever lands it by hand sees it first
      // (`sandcastle land` merges it as partly done and leaves the ticket open).
      const unmet = t.unmet ? ` - criterion unmet: ${t.unmet}${t.unmet.endsWith("…") ? ` (cut short - full text in the agents' logs, .sandcastle/logs/agent-issue-${id}-*.log)` : ""}` : "";
      // A held conflict resolution is landed with `sandcastle land`, which gates the merge; a hand merge runs no gate.
      const how = f.heldResolutions?.includes(id) ? `land: sandcastle land ${id}` : `merge: git merge --no-ff agent/issue-${id}`;
      return [`- ${name(id)} - ${why}${size}${unmet}`, `  review: git log -p ${f.base}..agent/issue-${id}   ${how}`];
    }),
    ...o.gone.map((id) => `- ${name(id)} - ${f.tickets[id].note ?? "held"} - its branch agent/issue-${id} is gone and no merge of it is on ${f.base}: do the work yourself, or put the ticket back (\`sandcastle requeue <ticket>\`) for a run to redo`),
    ...o.takenBack.map((id) => `- ${name(id)} - ${f.tickets[id].note} - branch agent/issue-${id} has the agents' work, if it helps`),
    ...o.handedBack.map((id) => `- ${name(id)} - ${f.tickets[id].note ?? "held"}, no commits - read the agent's comment: do it yourself and close the ticket, or answer its question and requeue it`),
    // The next run finds its own merge message and closes the ticket, so
    // nobody should merge or redo the work.
    ...(carried ? [] : o.notClosed).map(
      (id) => `- ${name(id)} - merged, but closing the ticket failed: ${f.tickets[id].closeFailed} - the next \`sandcastle run\` closes it, or close it by hand`,
    ),
    // The criterion is the agent's own words, cut at the cap like an ungated note. The implementer may
    // have said it, not a reviewer, so the pointer names every agent log of the ticket.
    ...o.partly.map((id) => {
      const note = f.tickets[id].unmet ?? "";
      const more = note.endsWith("…") ? ` (cut short - full text in the agents' logs, .sandcastle/logs/agent-issue-${id}-*.log)` : "";
      const then = o.partlyDecide.includes(id)
        ? `the remainder needs a person (the agent's note), so a run would only ask it again: do or decide it and close the ticket, or move it to the hold label${holdLabel}`
        : o.partlyAway.includes(id)
          ? "the ticket is still open but no longer in the queue, so no run takes it"
          : "and the next `sandcastle run` picks up the remainder";
      return `- ${name(id)} - merged, partly done: ${note}${more} - the ticket is still open${o.partlyDecide.includes(id) || o.partlyAway.includes(id) ? "; " : ", "}${then}`;
    }),
    // A note cut at the cap ends with "…": the whole of it is only in the reviewer's log.
    ...o.ungated.map((id) => {
      const note = f.tickets[id].ungated ?? "";
      const more = note.endsWith("…") ? ` (cut short - full text in .sandcastle/logs/agent-issue-${id}-review-${id}.log)` : "";
      return `- ${name(id)} - merged - check by hand: ${note}${more}`;
    }),
  ];
};

/**
 * The reviewer prose `gapOf` read as a gap, on a line of its own and counted nowhere: no Needs you bullet, no
 * `need you` in the headline, no Next step. The detector reads sentences, and approving prose ("correctly left
 * alone", "the remaining mentions are still true") keeps finding phrasings it takes for a gap, so a find is a
 * thing worth a glance, not work a person owes. Each sentence is cut at the cap like an ungated note; the earlier
 * turns' finds follow, marked with their turn.
 */
const gapLines = (f: Facts, o: Owed, carried: { turn: number; facts: Facts; o: Owed }[]): string[] => {
  const finds = [
    ...o.gapped.map((id) => ({ id, facts: f, turn: 0 })),
    ...carried.flatMap((c) => c.o.gapped.map((id) => ({ id, facts: c.facts, turn: c.turn }))),
  ].map(({ id, facts, turn }) => {
    const note = facts.tickets[id].gap ?? "";
    const more = note.endsWith("…") ? ` (cut short - full text in .sandcastle/logs/agent-issue-${id}-review-${id}.log)` : "";
    return `${refOf(id)} "${note}"${more}${turn ? ` (turn ${turn})` : ""}`;
  });
  return finds.length ? [`Worth a glance - the reviewer's prose may name a gap: ${finds.join("; ")}`] : [];
};

/** The Next step for a refused commit: the work is done, and a further turn or a redo would only repeat the refusal. */
const uncommittedSteps = (o: Owed): string[] =>
  o.uncommitted.length
    ? [`Commit the finished work of ${listOf(o.uncommitted)}: fix what refused the commit (a hook, a full disk, signing), then \`sandcastle requeue <ticket>\` - the next run reuses the kept worktree - or commit it there yourself (paths under Needs you).`]
    : [];

/** The Next steps for what `ticketLines` lists, in the order the summary gives them. */
const ticketSteps = (f: Facts, o: Owed, carried: boolean): string[] => {
  const list = listOf;
  const holdLabel = f.holdLabel ? ` (\`${f.holdLabel}\`)` : "";
  const next: string[] = [];
  // The last turn's own comes first in `render`; an earlier turn's has no such place, so it leads its own steps.
  if (carried) next.push(...uncommittedSteps(o));
  const resolutions = o.heldWork.filter((id) => f.heldResolutions?.includes(id));
  const merges = o.heldWork.length - resolutions.length;
  if (merges) next.push(`Review and merge the ${merges} held branch(es) (commands above).`);
  if (resolutions.length) next.push(`Check and land the ${resolutions.length} held conflict resolution(s) (commands above): \`sandcastle land <ticket>\` gates the merge.`);
  if (o.gone.length) next.push(`Decide ${list(o.gone)}: the branch is gone and nothing of it is on ${f.base}, so do the work yourself, or \`sandcastle requeue <ticket>\` for a run to redo it.`);
  if (o.handedBack.length) next.push(`Read the agent's comment on ${list(o.handedBack)}: work only a person can do, do it and close the ticket; a question, answer it and requeue: \`sandcastle requeue <ticket> --note "..."\`.`);
  if (o.notClosed.length && !carried) next.push(`Close ${list(o.notClosed)} (merged, still open), or leave it to the next \`sandcastle run\`.`);
  const partlyNext = o.partly.filter((id) => !o.partlyDecide.includes(id) && !o.partlyAway.includes(id));
  if (partlyNext.length) next.push(`Read what is left on ${list(partlyNext)} (merged, partly done, ticket open): the next \`sandcastle run\` picks up the remainder, or finish it yourself and close the ticket.`);
  if (o.partlyDecide.length) next.push(`Do or decide what is left on ${list(o.partlyDecide)} (merged, partly done; the agent's note says it needs a person): close the ticket once it is done, or move it to the hold label${holdLabel} so a run does not spend an agent on it.`);
  if (o.partlyAway.length) next.push(`${list(o.partlyAway)} merged partly done and is no longer in the queue: finish the remainder yourself, or put the ticket back (\`sandcastle requeue <ticket>\`) for a run to pick up.`);
  if (o.ungated.length) next.push(`Check ${list(o.ungated)} by hand: merged, but no gate exercises the change (what to check is under Needs you).`);
  return next;
};

/** Ends a carried bullet with the turn it comes from; the indented rows under one are commands to copy, and stay as they are. */
const fromTurn = (turn: number, lines: string[]) => lines.map((l) => (l.startsWith("- ") ? `${l} (turn ${turn})` : l));

/** The closing summary as Markdown-ish text, every section present. */
export const render = (f: Facts, plain = false): string => {
  const o = owed(f);
  const { ids, merged, notClosed, partly, closed, partlyRerun, ungated, byHand, held, uncommitted, followUps, filingFailed, toTriage } = o;
  const name = (id: string) => nameOf(f, id);
  const list = listOf;
  // What the earlier turns of this run left for a person (`Facts.carried`), one set per turn.
  const carried = (f.carried ?? []).map(({ turn, facts }) => ({ turn, facts, o: owed(facts) }));
  const carriedNeed = carried.reduce((n, c) => n + c.o.held.length + c.o.uncommitted.length + new Set([...c.o.partly, ...c.o.ungated]).size + c.o.filingFailed, 0);
  // The kept worktrees of the earlier turns' tickets, oldest first, one per path and none the last turn lists itself.
  const earlierTurnKept = carried
    .flatMap((c) => carriedKept(c.facts).map((k) => ({ ...k, turn: c.turn, state: c.facts.tickets[k.issue]?.state })))
    .filter((k, i, all) => all.findIndex((o) => o.path === k.path) === i && !f.keptWorktrees.some((own) => own.path === k.path));
  const carriedTriage = carried.reduce((n, c) => n + c.o.toTriage, 0);
  const fixing = ids(NEEDS_FIXING);
  // Put back in the queue while the run was going (landing found it red together with another ticket, say):
  // it runs again next time, and nothing here asks a person to act on it.
  // A fact about the attempt, not a ticket state: the record says "queued" and carries the line in `requeued`.
  const requeued = ids(["queued"]).filter((id) => !!f.tickets[id].requeued);
  // The gates on the base were red before any agent ran: nothing was attempted,
  // and the queue is untouched. Said first, as nothing below it is news.
  const baseRed = f.stage === "base gates" && !!f.finished && typeof f.exitCode === "number" && f.exitCode !== 0 &&
    !Object.values(f.tickets).some((t) => t.started);
  // Ended before its summary (Ctrl-C, a crash, kill -9): its tickets mid-work were
  // counted as attempted and listed nowhere, under a headline that said "finished".
  const early = !baseRed && !f.stopped && !f.live &&
    (!!f.killed || !!f.stoppedBy || (!!f.finished && f.stage !== "report" && typeof f.exitCode === "number" && f.exitCode !== 0));
  // Parked at a juncture of a paused run when it ended (crashed, killed, or stopped by any cause, which wakes it - a usage
  // stop as well as the guard's, which leave no `stopped` or early exit): a run that is not live is not paused. Nothing
  // was cut short, its branch holds every commit and the next run picks it up, so it is runnable, not cut.
  const parked = f.live ? [] : Object.keys(f.tickets).filter((id) => f.tickets[id].state === "paused");
  const cut = early ? Object.keys(f.tickets).filter((id) => sectionOf(f.tickets[id].state) === "working" && f.tickets[id].state !== "paused" && !(f.dryRun && f.tickets[id].state === "ready")) : [];
  const unstarted = early ? ids(["queued"]).filter((id) => !requeued.includes(id)) : [];
  // Blocked tickets are counted apart: the run would not have started them, and the sections below name only
  // the skipped and unstarted ones as "Not started", so a headline folding them in disagreed with its own lines.
  // The count is the "Still blocked" lines', not the record's state: one whose blockers this run closed is named runnable.
  const notStarted = ids(baseRed ? ["queued", "skipped"] : ["skipped"]).concat(unstarted);
  const blockedCount = f.blocked.length;
  const nochange = ids(["nochange"]);
  const withdrawn = ids(["withdrawn"]);
  const stoppedIds = ids(["stopped"]).filter((id) => !byHand.includes(id));
  // A dry run's green branches end as "ready": they would have merged.
  const wouldMerge = f.dryRun ? ids(["ready"]) : [];
  // Withdrawn before its sandbox started: someone's decision, not an attempt.
  const attempted = baseRed ? 0 : Object.values(f.tickets).filter((t) => sectionOf(t.state) && !LEFT.includes(t.state!) && !(t.state === "withdrawn" && !t.started)).length - unstarted.length;
  const closedWhere = f.tracker === "github" ? "closed on GitHub" : "marked done in their ticket files (committed on your local " + f.base + ")";
  // The image the verify ran on, from the record (a file in a repository: a value of the wrong type is no image). The
  // run's image is built before any ticket lands, so a Dockerfile a merged ticket changed is not in it: the verify
  // gated the merged tree on the old image, and only a rebuild shows how the new one does.
  const verifyImage = typeof f.verify?.image === "string" && f.verify.image ? ` on image ${f.verify.image}` : "";
  // The tests the red verify named (a file in a repository: only strings count).
  const verifyTests = Array.isArray(f.verify?.failing) ? f.verify!.failing.filter((t): t is string => typeof t === "string" && !!t) : [];
  const verifyFailing = verifyTests.length ? ` - failing: ${verifyTests.join(", ")}${f.verify?.failingMore === true ? ", and more" : ""}` : "";
  // The ticket whose gates passed the verified tree (a file in a repository: only a string counts).
  const sameTree = typeof f.verify?.gatedTree === "string" && f.verify.gatedTree ? f.verify.gatedTree : "";
  const cleanTree = typeof f.verify?.cleanTree === "string" && f.verify.cleanTree ? f.verify.cleanTree : "";
  const newDockerfiles = Array.isArray(f.verify?.dockerfiles) ? f.verify!.dockerfiles.filter((d): d is string => typeof d === "string" && !!d) : [];
  const startingImage = newDockerfiles.length
    ? ` Merged work changed ${newDockerfiles.join(", ")}, so this ran on the run's starting image - rebuild and run sandcastle gates to check the new one.`
    : "";
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
      : `${h("## 🏁 Run", "## Run")} ${f.stopped ? (merged.length ? `STOPPED - ${merged.length} merged before it stopped` : "STOPPED before landing - nothing was merged") : f.live ? (f.paused ? `still running, paused since ${hhmm(new Date(f.paused.since * 1000).toISOString())} - partial summary` : "still running - partial summary") : f.stoppedBy ? `${stoppedByText(f.stoppedBy)} - partial summary` : f.killed ? "ended without a clean exit (killed?) - partial summary" : early ? `ended early (exit ${f.exitCode}) - partial summary` : "finished"}${f.dryRun ? " (dry run)" : ""}`,
    (end ? `${hhmm(f.started)} to ${hhmm(end)} (${span(Date.parse(end) - Date.parse(f.started))})` : `From ${hhmm(f.started)}, end not recorded`) +
      ` - ${attempted} attempted - ` +
      `${f.dryRun ? `${wouldMerge.length} would merge` : `${merged.length} merged`} - ${held.length + uncommitted.length + new Set([...notClosed, ...partly, ...ungated]).size + (f.baseRed ?? []).length + filingFailed + carriedNeed} need you - ${fixing.length} need fixing - ` +
      // Its own count, and only when there is one: a person triages these, no ticket of the run needs them.
      `${toTriage + carriedTriage ? `${toTriage + carriedTriage} to triage - ` : ""}` +
      `${notStarted.length} not started${blockedCount ? ` - ${blockedCount} blocked` : ""}${f.tokenTotal ? ` - tokens ${tokenLine(f.tokenTotal)}` : f.tokens ? ` - tokens ${f.tokens}` : ""}`,
    baseRed
      ? `Base gates: red - ${f.baseGates?.filter((g) => !g.ok).map((g) => g.gate).join(", ") || "failing gates not recorded; see .sandcastle/logs/base-gates.log"}`
      : f.verify === undefined || f.verify === null
      // null: the run ended and chose not to (no merge this run - a ticket closed
      // as merged earlier merges nothing); undefined: it never got there.
      ? `Merged ${f.base} not re-gated (${f.verify === null ? "no branch merged in this run" : f.stopped ? "the stop skipped it" : early ? "the run ended before it got there" : "no result recorded"}).`
      : f.verify.green && f.verify.skipped
        ? `${verifySkippedLine(f.base, f.verify.skipped, verifyImage)}.${startingImage}`
      : f.verify.green
        ? `Merged ${f.base} re-gated: all ${f.gateCount} gates green${verifyImage}.${startingImage}`
        : `Merged ${f.base} re-gated: ${sameTree ? `RED in a clean sandbox on the tree ${sameTree}'s own gates passed - the difference is the sandbox, not the merge` : cleanTree ? `RED on the tree ${cleanTree}'s landing gates passed in a clean sandbox - likely a flaky or order-dependent test, not the merge` : "RED TOGETHER"} (${f.verify.line})${verifyFailing}${verifyImage} - do not push ${f.base} until it is fixed. Output: .sandcastle/logs/verify-gates.log${startingImage}`,
  );
  const models = Object.entries(f.byModel ?? {});
  if (models.some(([model]) => model !== NO_MODEL)) {
    const size = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead + t.output;
    out.push(`Tokens by model: ${models.sort(([, a], [, b]) => size(b) - size(a)).map(([model, t]) => `${model} ${tokenLine(t)}`).join(" · ")}`);
  }
  out.push(...settingsLines(f, plain));
  // Those checks read an unanswered merge as clean, so the summary is where a person learns they did not run.
  if (f.mergeUnchecked) out.push(`Merge checks: ${f.mergeUnchecked}.`);
  out.push(...gapLines(f, o, carried));
  if (f.stopped) out.push(f.stopped);
  if (f.setupProblem) out.push(`Stopped starting tickets: ${setupProblemWords(f.setupProblem)}.`);
  if (f.dryRunCheck) out.push(f.dryRunCheck);

  // Done
  const done: string[] = [];
  if (closed.length) done.push(`${closed.length} merged and ${closedWhere}: ${list(closed)}`);
  // Merged with the close refused: done in git, still open in the tracker - not "closed on GitHub".
  if (notClosed.length) done.push(`${notClosed.length} merged, but still open in the tracker: ${list(notClosed)} (see Needs you)`);
  // Merged, but not closed on purpose: a criterion is unmet, so the next run does the rest.
  if (partly.length) done.push(`${partly.length} merged, partly done, and left open in the tracker: ${list(partly)} (see Needs you)`);
  if (closed.length && f.tracker === "github") done.push(`Closed on GitHub, but the code is only on your local ${f.base} until you push it.`);
  else if (merged.length) done.push(`The code is only on your local ${f.base} until you push it.`);
  // A ticket the scheduler sent back once (a conflict or a red gate at landing) and landed on its second attempt.
  // `requeued` stays on a merged ticket's record, and is null when the second attempt never began.
  const sentBack = new Map<string, string[]>();
  for (const id of merged.filter((id) => !!f.tickets[id].requeued)) {
    const line = f.tickets[id].requeued!;
    // Where the conflict was found is in the line (`requeuedLine`); an older run record has none, and says none.
    const found = line.match(/^requeued after conflict (before review|before gates|at landing)/)?.[1];
    const where = found === "at landing" ? " at landing" : found ? ` found ${found.replace("before ", "before its ")}` : "";
    const why = line.startsWith("requeued after conflict") ? `sent back after a conflict${where}` : line.startsWith("requeued after red") ? "sent back after a red gate at landing" : "sent back at landing";
    sentBack.set(why, [...(sentBack.get(why) ?? []), id]);
  }
  if (sentBack.size) done.push(`Landed on a second attempt: ${[...sentBack].map(([why, who]) => `${who.map(refOf).join(", ")} (${why})`).join("; ")}`);
  if (wouldMerge.length) {
    // Each branch was gated alone; whether they merge together is a separate question.
    const together = wouldMerge.length > 1 ? " Each was gated on its own: `sandcastle preview` shows which would conflict with each other." : "";
    done.push(`Dry run - green, would merge: ${list(wouldMerge)}. Nothing was merged or closed.${together}`);
  }
  // A warning on a ticket that landed: the line is agent-written, so nothing was held for it.
  for (const id of merged.filter((id) => overrunNoted(f.tickets[id].overrun))) done.push(`${name(id)} - beyond Touches: ${overrunPaths(f.tickets[id].overrun!)}`);
  const byHandShut = byHand.filter((id) => f.mergedByHandClosed?.includes(id));
  const byHandPart = byHand.filter((id) => !byHandShut.includes(id) && f.mergedByHandPartly?.includes(id));
  const byHandOpen = byHand.filter((id) => !byHandShut.includes(id) && !byHandPart.includes(id));
  // A ticket the run stopped before landing is "stopped", not "held": it was merged by hand all the same.
  const byHandLine = (group: string[], tail: string) => {
    for (const [what, who] of [["held", group.filter((id) => f.tickets[id].state === "held")], ["stopped", group.filter((id) => f.tickets[id].state === "stopped")]] as const) {
      if (who.length) done.push(`${who.length} ${what}, merged by hand${tail}: ${list(who)}`);
    }
  };
  byHandLine(byHandOpen, "; closes on push");
  // A "part of" merge never closes its ticket: the criterion it left undone is for the next run, or a person.
  if (byHandPart.length) {
    byHandLine(byHandPart, ", partly done: stays open");
    for (const id of byHandPart) if (f.tickets[id].unmet) done.push(`${name(id)} - criterion unmet: ${f.tickets[id].unmet}`);
  }
  byHandLine(byHandShut, ", and closed");
  if (nochange.length) done.push(`Nothing to change: ${list(nochange)} - left open, with the agent's evidence in a comment`);
  // Someone's decision during the run; its branch stands in case they want it.
  for (const id of withdrawn) {
    const kept = f.standing.includes(`agent/issue-${id}`) ? ` (branch agent/issue-${id} kept)` : "";
    done.push(`Not landed, as the tracker said during the run: ${name(id)} - ${f.tickets[id].note ?? "withdrawn"}${kept}`);
  }
  // Changelog lines the agents suggested (`changelog: true`), for the tickets that landed: the
  // maintainer writes the entries from them.
  done.push(...changelogLines(merged.flatMap((id) => (f.tickets[id].changelog ?? []).map((line) => ({ id, line })))));
  const dropped = merged.filter((id) => f.tickets[id].changelogDropped);
  // Never shown cut off: a tag too long, a list or holding a commit sha is an agent's message, not a line.
  for (const id of dropped) done.push(...droppedLines(refOf(id), f.tickets[id].changelogDropped!, f.tickets[id].changelogDroppedWhy));
  section(h("## ✅ Done", "## Done"), done);

  // Needs you
  const triaged = (g: Facts, u: FiledFollowUp) => !!u.id || (!u.failed && g.dryRun);
  section(
    h("## 🙋 Needs you", "## Needs you"),
    [
      ...ticketLines(f, o, false),
      // Once, whatever the number of branches that failed on it: it is the base's, not theirs.
      ...(f.baseRed ?? []).map((t) => `- base went red mid-run: ${t} - it fails on ${f.base} itself, so no branch was repaired for it: fix ${f.base} first; the tickets under Needs fixing that failed on it were not repaired`),
      // Filing failed or never happened in a real run: a person files it by hand, so it is theirs, not triage's.
      ...byHandLines(f, followUps.filter((u) => !u.id && (u.failed || !f.dryRun))),
      // What the earlier turns of this run left, oldest first: the loop's later turns only re-run some tickets, so
      // the rest would be said nowhere else.
      ...carried.flatMap((c) => [
        ...fromTurn(c.turn, ticketLines(c.facts, c.o, true)),
        ...fromTurn(c.turn, byHandLines(c.facts, c.o.followUps.filter((u) => !u.id && (u.failed || !c.facts.dryRun)), c.turn)),
      ]),
      // The rest are for triage, under a heading of their own so the headline's `need you` and `to triage` each
      // match a group of bullets.
      ...(toTriage + carriedTriage ? ["### To triage"] : []),
      ...followUps.filter((u) => triaged(f, u)).map((u) => followUpLine(f, u)),
      ...(f.filed ?? []).map((i) => `- #${i.id} ${i.title} - opened during this run: triage it, then queue or close it`),
      ...carried.flatMap((c) => [
        ...fromTurn(c.turn, c.o.followUps.filter((u) => triaged(c.facts, u)).map((u) => followUpLine(c.facts, u))),
        ...fromTurn(c.turn, (c.facts.filed ?? []).map((i) => `- #${i.id} ${i.title} - opened during this run: triage it, then queue or close it`)),
      ]),
    ],
  );

  // Needs fixing, with what several branches have in common
  const fixLines = fixing.map((id) => {
    const t = f.tickets[id];
    const what = t.state === "conflict"
      ? `merge conflict: ${t.note ?? ""}`
      : redTogether(f, id)
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
    return s && s !== "merged" ? ` (${s === "red" ? (redTogether(f, id!) ? "red together" : "gate red") : s})` : "";
  };
  const skipped = ids(["skipped"]);
  // Why each one can run, from the record: a ticket held for an overlap says which ticket it waited
  // for (and whether that one landed); one that waited on blockers, which; a conflicted one resumes its branch.
  const runnableWhy = (id: string) => {
    const t = f.tickets[id] ?? {};
    if (t.state === "paused") return `paused${t.note ? ` ${t.note}` : ""} - its branch resumes`;
    if (t.state === "conflict") return "conflicted - its branch resumes";
    if (partlyRerun.includes(id)) return "merged partly done - the remainder is still open";
    const overlap = /^waits for (\S+) \(this run\) - next run$/.exec(t.note ?? "");
    if (overlap) {
      const partner = Object.keys(f.tickets).find((k) => refOf(k) === overlap[1] || k === overlap[1]);
      const state = partner ? f.tickets[partner].state : undefined;
      return `held for overlap with ${overlap[1]}${state === "merged" ? ", now landed" : state ? ` (${state})` : ""}`;
    }
    const on = /^waits for (.*)$/.exec(t.note ?? "")?.[1]?.replace(/\s*\([^)]*\)/g, "").split(",").map((l) => l.trim()).filter(Boolean) ?? [];
    return on.length ? `${on.length === 1 ? "blocker" : "blockers"} ${on.join(", ")} closed` : "blockers closed";
  };
  const runnable = [...new Set([...Object.keys(f.tickets).filter((id) => f.runnable.includes(id) || f.tickets[id].state === "conflict"), ...f.runnable, ...partlyRerun, ...parked])];
  const anyLeft = runnable.length + f.blocked.length + skipped.length + requeued.length + cut.length + unstarted.length > 0 || !!f.blockCheck;
  section(h("## ▶️ Runnable now / ⏳ Still blocked", "## Runnable now / Still blocked"), anyLeft ? [
    // A ticket cut short is runnable too, and its own line follows: "none" above it would contradict it.
    ...(runnable.length || !cut.length ? [`▶️ Runnable now: ${runnable.length ? runnable.map((id) => `${refOf(id)} (${runnableWhy(id)})`).join(", ") : "none"}`] : []),
    ...f.blocked.map((b) => `⏳ ${refOf(b.id)} waits for ${b.on.map((l) => `${l}${ticketState(l)}${b.why?.[l] ? ` - ${b.why[l]}` : ""}`).join(", ") || "blockers that could not be read"}`),
    ...(skipped.length ? [`Not started (the run stopped early): ${list(skipped)}`] : []),
    ...planLimitLines(f, skipped),
    ...requeued.map((id) => `Requeued: ${name(id)}${f.tickets[id].requeued ? ` - ${f.tickets[id].requeued}` : ""} - still queued for the next run`),
    ...(cut.length ? [`Cut short when the run ended: ${cut.map((id) => `${refOf(id)} (${f.tickets[id].state})`).join(", ")} - still queued`] : []),
    ...(unstarted.length ? [`Not started (the run ended early): ${list(unstarted)}`] : []),
    ...(f.blockCheck ? [`Could not re-read blockers: ${f.blockCheck}`] : []),
  ] : []);

  // Local state
  const earlier = f.earlierHeld ?? {};
  const isResolution = (b: string) => !!f.heldResolutions?.includes(b.replace(/^agent\/issue-/, ""));
  // The landing hold's own text is the generic wording: said once, not again as the reason.
  const earlierWords = (b: string) =>
    isResolution(b)
      ? `its conflict resolution was held in an earlier run${earlier[b] ? `: ${earlier[b].replace(/^needs a human: /, "")}` : ""}`
      : `held for a human merge in an earlier run${earlier[b] && earlier[b] !== LANDING_HOLD ? `: ${earlier[b]}` : ""}`;
  section(h("## 📤 Local state", "## Local state"), [
    f.ahead === undefined
      ? `${f.base} has no upstream to compare with.`
      : `${f.base} is ${f.ahead} commit(s) ahead of ${f.upstream} (as of the last fetch).`,
    "Nothing is pushed by Sandcastle. Push by this repo's own rules (for example `git push`, or a pull request).",
    `Agent branches with unmerged work: ${f.standing.length ? f.standing.map((b) => (b in earlier ? `${b} (${earlierWords(b)})` : b)).join(", ") : "none"}`,
    // By path: a requeued ticket's second pipeline keeps the same worktree, and one line per path is the fact.
    ...f.keptWorktrees
      .filter((k, i) => f.keptWorktrees.findIndex((o) => o.path === k.path) === i)
      .map((k) => `Worktree kept with uncommitted files: ${refOf(k.issue)} - ${k.path}`),
    // An earlier turn's, which the last turn's record never lists (each turn starts a fresh list).
    ...earlierTurnKept.map((k) => `Worktree kept with uncommitted files: ${refOf(k.issue)} - ${k.path} (turn ${k.turn})`),
    ...earlierKeptLines(f),
    ...(f.gateRewrites ?? []).map(rewroteLine),
  ]);

  // Next step: the first thing that unblocks the most, then the rest in order.
  const next: string[] = [];
  // A re-run of a ticket that failed on a red base goes red the same way: the base comes before any ticket.
  const redTests = f.baseRed ?? [];
  if (redTests.length) {
    next.push(
      `Fix ${f.base} first: ${redTests.join(", ")} ${redTests.length === 1 ? "fails" : "fail"} on ${f.base} itself; ` +
        `once \`sandcastle gates\` is green, \`sandcastle run\` again for the tickets under Needs fixing that failed on it.`,
    );
  }
  // First: the work is done, and a further turn or a redo would only repeat the refusal.
  next.push(...uncommittedSteps(o));
  if (baseRed) {
    next.push(
      `Fix the base: read .sandcastle/logs/base-gates.log, then \`sandcastle gates\` to check; the queue is untouched, so \`sandcastle run\` afterwards starts the same tickets.`,
    );
  }
  if (f.stopped) {
    const land = stoppedIds.length ? ` - ${list(stoppedIds)} finished and land then.` : ".";
    // Only a moved base can be a person's own commit; any other `.git` change is read and put right first. A record
    // from before the cause was kept (`stoppedWhat` absent) keeps the old words.
    next.push(
      f.stoppedWhat === undefined || f.stoppedWhat === `${f.base} moved while sandboxes ran`
        ? `Check what stopped the run (above). If it is your own commit, \`sandcastle run\` again${land}`
        : `Check what stopped the run (above): it names what changed in the shared .git and how to inspect it. Once that is put right or understood, \`sandcastle run\` again${land}`,
    );
  }
  if (f.verify && !f.verify.green) {
    const same = typeof f.verify.gatedTree === "string" && f.verify.gatedTree ? f.verify.gatedTree : "";
    const clean = typeof f.verify.cleanTree === "string" && f.verify.cleanTree ? f.verify.cleanTree : "";
    next.push(
      same
        ? `Fix ${f.base}: the gates are red in a clean sandbox on the tree ${same}'s own gates passed - look at the sandbox (git identity, environment), not at the tickets meeting. Do not push until they are green.`
        : clean
          ? `Fix ${f.base}: the gates are red on the tree ${clean}'s landing gates passed in a clean sandbox - run \`sandcastle gates\` again to see whether a test is flaky or order-dependent. Do not push until they are green.`
          : `Fix ${f.base}: merged together, the gates are red. Do not push until they are green.`,
    );
  }
  if (sameTest.length) next.push(`Fix ${sameTest.map(([test]) => test).join(", ")} once - it fails on ${new Set(sameTest.flatMap(([, w]) => w)).size} of the unmerged branches.`);
  // Grouped, these tickets got no step of their own (see `lone`): say here what the next run does with them.
  if (sameFile.length) {
    const ids = [...new Set(sameFile.flatMap(([, w]) => w))];
    next.push(
      `Start with ${sameFile.map(([file]) => file).join(", ")}: ${list(ids)} fail or conflict there. They are still queued: ` +
        `the next \`sandcastle run\` resumes each branch, merging ${f.base} into it first; or fix one yourself and land it: \`sandcastle land <n>\`.`,
    );
  }
  next.push(...ticketSteps(f, o, false));
  // The earlier turns' steps follow, each marked: only the last turn's summary says them, and its own were no help for those tickets.
  for (const c of carried) next.push(...ticketSteps(c.facts, c.o, true).map((n) => n.replace(/\.$/, ` (turn ${c.turn}).`)));
  // Crashed alike expanding their prompt: the setup's fault, so no step asks for a comment on a ticket.
  const setupCrashed = f.setupProblem ? fixing.filter((id) => f.tickets[id].state === "crashed" && sameExpansionFailure(f.tickets[id].note ?? "", f.setupProblem!)) : [];
  if (f.setupProblem) {
    next.push(`Fix the setup problem (above): run \`sandcastle doctor --verify\`, put right what it names, then \`sandcastle run\` again for ${list([...setupCrashed, ...skipped])} - the tickets themselves are fine.`);
  }
  const lone = fixing.filter((id) => ![...sameTest, ...sameFile].some(([, w]) => w.includes(id)) && !setupCrashed.includes(id));
  // These tickets keep their queue label (the kit only comments on them), so "requeue" sent operators
  // looking for a step that does not exist; the next run resumes the kept branch instead.
  // `sandcastle land` merges and gates the way a run does; a hand-written merge skips both.
  if (lone.length) next.push(`Look at ${list(lone)}: still queued - add a comment for the implementer if it helps, and the next \`sandcastle run\` resumes its branch; or fix the branch yourself and land it: \`sandcastle land ${lone.length === 1 ? lone[0] : "<n>"}\`.`);
  // Never closed by the kit (the agent may be wrong), and still queued: every later run would pay for it again.
  if (nochange.length) next.push(`Read the agent's comment on ${list(nochange)} (nothing to change): close it if the evidence holds, or add what is missing - while it stays queued, every \`sandcastle run\` tries it again.`);
  if (f.runnable.length) next.push(`Run again for the ${f.runnable.length} ticket(s) this run unblocked: \`sandcastle run\`.`);
  if (skipped.length && !f.setupProblem) next.push(`Run again for the ${skipped.length} ticket(s) that never started.`);
  if (requeued.length) next.push(`\`sandcastle run\` again for ${list(requeued)}: requeued during this run.`);
  // They keep their queue label, and the next run resumes a kept branch rather than starting over.
  if (parked.length + cut.length + unstarted.length) {
    next.push(
      `\`sandcastle run\` again: it picks up ${list([...parked, ...cut, ...unstarted])} where this run ended` +
        (f.killed ? ", and first stops any sandbox the killed run left working." : "."),
    );
  }
  // A red base is red for whoever pulls it too.
  const push = f.ahead ? (baseRed ? `Do not push ${f.base} (${f.ahead} commit(s)) until its gates are green.` : `Push ${f.base} (${f.ahead} commit(s)) under this repo's rules.`) : undefined;
  if (push) next.push(push);
  // `sandcastle land` refuses a branch held for a protected path or a large file, and plain `clean` keeps an unmerged branch: the person merges it or deletes it.
  const heldEarlier = f.standing.filter((b) => b in earlier && !isResolution(b));
  const resolvedEarlier = f.standing.filter((b) => b in earlier && isResolution(b));
  if (resolvedEarlier.length) {
    const one = resolvedEarlier.length === 1;
    const b = one ? resolvedEarlier[0] : "<branch>";
    const n = one ? resolvedEarlier[0].replace(/^agent\/issue-/, "") : "<n>";
    next.push(
      `Check the resolution on ${resolvedEarlier.join(", ")}, held in an earlier run: \`git log -p ${f.base}..${b}\`; if no other ticket's lines were lost, \`sandcastle land ${n}\` lands ${one ? "it" : "each"} with the gates; ` +
        `if some were, fix the branch first, or \`sandcastle requeue ${n} --note "..."\`.`,
    );
  }
  if (heldEarlier.length) {
    const one = heldEarlier.length === 1;
    const b = one ? heldEarlier[0] : "<branch>";
    next.push(`Resolve ${heldEarlier.join(", ")}, held for a human merge in an earlier run: review ${one ? "it" : "each"} with \`git log -p ${f.base}..${b}\` and merge by hand with \`git merge --no-ff ${b}\`, or drop ${one ? "it" : "one"} with \`git branch -D ${b}\`.`);
  }
  // A merged ticket's kept worktree (a stray file its agent left, a gate restore that failed) holds the branch the landing could not delete,
  // and no other step reaches it. Only a merged one: `clean` removes every worktree, and the others hold work a run or a person still needs.
  const mergedKept = [
    ...f.keptWorktrees
      .filter((k, i) => f.keptWorktrees.findIndex((o) => o.path === k.path) === i && f.tickets[k.issue]?.state === "merged")
      .map((k) => `${refOf(k.issue)} (\`${k.path}\`)`),
    ...earlierTurnKept.filter((k) => k.state === "merged").map((k) => `${refOf(k.issue)} (\`${k.path}\`, turn ${k.turn})`),
  ];
  // Earlier runs' kept worktrees (`earlierKept`): too many to name, so counted. `clean` removes the unmerged ones with their uncommitted files, so those are looked at first.
  const earlierKept = f.earlierKept ?? [];
  const earlierMerged = earlierKept.filter((k) => k.merged);
  const earlierOpen = earlierKept.length - earlierMerged.length;
  const earlierKeptWords = earlierMerged.length
    ? `${earlierMerged.length === 1 ? "the 1 merged worktree" : `the ${earlierMerged.length} merged worktrees`} kept by earlier runs${sizeWords(earlierMerged)}${earlierOpen ? `, and the ${earlierOpen} that ${earlierOpen === 1 ? "holds" : "hold"} work not on ${f.base} (their uncommitted files too: look at those first)` : ""}`
    : "";
  if (!baseRed) {
    if (f.standing.length) {
      next.push(`\`sandcastle clean\` once the branches above are resolved${mergedKept.length ? ` and you have looked at the files left in the kept worktree of ${mergedKept.join(", ")}` : ""}${earlierKeptWords ? `: it also removes ${earlierKeptWords}` : ""}.`);
    } else if (mergedKept.length) {
      next.push(
        mergedKept.length === 1
          ? `Look at the files left in the kept worktree of ${mergedKept[0]}: its work is merged. ` +
              "Then `sandcastle clean` removes it and the branch it holds and archives its logs - and removes every other kept worktree too, so do the steps above first."
          : `Look at the files left in the kept worktrees of ${mergedKept.join(", ")}: their work is merged. ` +
              "Then `sandcastle clean` removes them and the branches they hold and archives their logs - and removes every other kept worktree too, so do the steps above first.",
      );
      if (earlierKeptWords) next[next.length - 1] += ` Among them: ${earlierKeptWords}.`;
    } else if (earlierKeptWords) {
      next.push(`\`sandcastle clean\` removes ${earlierKeptWords}, with the branches they hold, and archives their logs - after the steps above.`);
    }
  }
  // Another turn follows at once: everything above is that turn's work, and only the last turn's steps are the operator's.
  const steps = f.next
    ? [`Autonomy level ${f.next.level} runs turn ${f.next.turn} of ${f.next.level === "drain" ? `at most ${DRAIN_CAP}` : f.next.level} next for ${f.next.tickets.map(refOf).join(", ")}; what needs you from this turn is carried into the last turn's summary.`, ...(push ? [push] : [])]
    : next;
  section(h("## 👉 Next step", "## Next step"), steps.map((n, i) => `${i + 1}. ${n}`));
  return out.join("\n");
};

/**
 * The Next step section alone, as the operator's. A drain turn's summary hands its Next step to
 * the loop ("runs turn N next"), but the loop can still stop after it (drainStop): then these
 * are the steps the operator never saw. Next step is the summary's last section.
 */
export const operatorSteps = async (project: Project) => {
  const text = render(await gather(project), !!process.env.NO_COLOR);
  return text.slice(text.lastIndexOf("## "));
};

/** The summary for the project's last recorded run. */
export const closingReport = async (project: Project, turn?: { level: Level; turn: number }) => {
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

// ---------------------------------------------------------------------------
// `sandcastle report --changelog`: the suggested lines of every ticket that landed since a ref,
// across runs. The closing summary shows only the last run's; a release spans many.
// ---------------------------------------------------------------------------

type HistoryRecord = { startedAt?: string; dryRun?: boolean; tickets?: unknown };

const parseRecord = (text: string): HistoryRecord | undefined => {
  try {
    const run = JSON.parse(text);
    return run && typeof run === "object" && !Array.isArray(run) ? run : undefined;
  } catch {
    return undefined;
  }
};

/** The commit time (ISO) of a git ref, or undefined when the ref names no commit. */
const commitTime = (root: string, ref: string) => git(["log", "-1", "--format=%cI", `${ref}^{commit}`], root) || undefined;

// What the summary says of the changelog tags a ticket's agents gave that were left out. Each one `why` knows
// (`changelogScan`) is told by its reason, a length drop with its length; the rest - an older record has a
// count and no reasons - are one line, as before. Never shown cut off: a tag too long, a list or holding a
// commit sha is an agent's message, not a line.
const droppedLines = (ref: string, count: number, why: unknown): string[] => {
  const known = Array.isArray(why) ? why.filter((w): w is string => typeof w === "string").slice(0, count) : [];
  const left = ", so write that entry from the ticket.";
  const out = known.map((w) => (w.startsWith("too long") ? `A suggested line for ${ref} was ${w}: it is left out${left}` : `A suggested line for ${ref} was not a changelog line (it ${w}): it is left out${left}`));
  const unknown = count - known.length;
  if (unknown > 0) out.push(`A suggested line for ${ref} was not a changelog line${unknown > 1 ? ` (${unknown} of them)` : ""}: it is left out${left}`);
  return out;
};

/**
 * What landed since `since` (a git ref; default the latest tag reachable from the base branch,
 * else all history): the tickets merged in runs that started after the ref's commit time, read
 * from `logs/history.jsonl` and the current `logs/run.json`. A ticket merged in several runs is
 * shown once, with the lines of its latest run that has any. A line that does not parse is skipped.
 * A ticket landed with `sandcastle land` is in no run's `merged`: its kit-worded merge subject on the base after the ref
 * finds it, with the heads record's lines, else a run record's, else under "No suggested line".
 */
export const changelogSince = (project: Project, since?: string): string => {
  const root = project.root;
  const logs = join(root, ".sandcastle/logs");
  const ref = since ?? (git(["describe", "--tags", "--abbrev=0", project.baseBranch], root) || undefined);
  const after = ref ? commitTime(root, ref) : undefined;
  if (ref && !after) throw new OperatorError(`\`${ref}\` is not a git ref of this project: give a tag or commit, as in \`sandcastle report --changelog --since v1.2.0\`.`);
  const read = (file: string) => (existsSync(join(logs, file)) ? readFileSync(join(logs, file), "utf8") : "");
  // The current record is last: a finished run is in both files, and the later copy replaces the earlier by its start.
  const runs = new Map<string, HistoryRecord>();
  for (const text of [...read("history.jsonl").split("\n").filter(Boolean), read("run.json")]) {
    const run = parseRecord(text);
    if (run && typeof run.startedAt === "string" && !Number.isNaN(Date.parse(run.startedAt))) runs.set(run.startedAt, run);
  }
  const landed = new Map<string, { title?: string; lines: string[]; dropped: number; why?: unknown }>();
  for (const run of [...runs.values()].sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))) {
    if (run.dryRun || (after && Date.parse(run.startedAt!) <= Date.parse(after))) continue;
    for (const [id, t] of Object.entries(readTickets(run))) {
      if (t.state !== "merged") continue;
      const before = landed.get(id);
      const lines = Array.isArray(t.changelog) ? t.changelog.filter((l): l is string => typeof l === "string") : [];
      // The latest run's lines; an earlier run's stand only while no later one gave any.
      const kept = lines.length || !before ? { lines, dropped: t.changelogDropped ?? 0, why: t.changelogDroppedWhy } : before;
      landed.set(id, { title: t.title ?? before?.title, lines: kept.lines, dropped: kept.dropped, why: kept.why });
    }
  }
  // Tickets landed with `sandcastle land` after a run stopped: no run record says `merged`, but the kit's merge subject is on
  // the base after the ref. Their lines are the heads record's, else the latest run record's that has any.
  const heads = readHeads(root);
  const subjects = git(["log", ref ? `${ref}..${project.baseBranch}` : project.baseBranch, "--format=%s"], root) ?? "";
  for (const subject of subjects.split("\n").reverse()) {
    const id = /^Merge agent\/issue-(.+) \((?:closes|part of) /.exec(subject)?.[1];
    if (!id || landed.has(id)) continue;
    // Newest first: the heads record, then each run's record of the ticket.
    const records = [heads[id], ...[...runs.values()].filter((run) => !run.dryRun).sort((x, y) => Date.parse(y.startedAt!) - Date.parse(x.startedAt!)).map((run) => readTickets(run)[id])].filter((r) => !!r);
    const linesOf = (r: { changelog?: unknown }) => (Array.isArray(r.changelog) ? r.changelog.filter((l): l is string => typeof l === "string") : []);
    const source = records.find((r) => linesOf(r).length) ?? records.find((r) => r.changelogDropped);
    landed.set(id, { title: (records.find((r) => "title" in r && r.title) as { title?: string } | undefined)?.title, lines: source ? linesOf(source) : [], dropped: source?.changelogDropped ?? 0, why: source?.changelogDroppedWhy });
  }
  const ids = [...landed.keys()];
  const out = [`${ids.length} ticket(s) landed in runs started after ${ref ? `${ref} (${after})` : "the start of the history"}.`];
  const all = ids.flatMap((id) => landed.get(id)!.lines.map((line) => ({ id, line })));
  out.push(...changelogLines(all));
  for (const id of ids.filter((id) => landed.get(id)!.dropped)) out.push(...droppedLines(refOf(id), landed.get(id)!.dropped, landed.get(id)!.why));
  const bare = ids.filter((id) => !landed.get(id)!.lines.length);
  if (bare.length) {
    out.push("No suggested line - write from the ticket:");
    for (const id of bare) out.push(`  ${refOf(id)}${landed.get(id)!.title ? ` ${landed.get(id)!.title}` : ""}`);
  }
  if (!all.length && ids.length && !project.changelog) out.push("This project has no `changelog: true`, so the agents were not asked for lines.");
  return out.join("\n");
};
