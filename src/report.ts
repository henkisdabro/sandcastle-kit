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
import { afterTurn, DRAIN_CAP, type Level, rerunnable, stillOpen } from "./autonomy.ts";
import { blockerResolver, blockerWhy, openBlockers, refLabel, whyShort } from "./blockers.ts";
import type { Project } from "./config.ts";
import { addTokens, mergedByHand, NO_TOKENS, readOutcomes, type Tokens, tokenLine } from "./run.ts";
import { commandOf } from "./live-runs.ts";
import { sh } from "./sandbox.ts";
import { isDocPath, isTestPath } from "./touches.ts";
import { makeTracker, refOf } from "./tracker.ts";
import { liveness, type Probe } from "../mod/hooks/run-live.ts";
import { isTicketState, type OutcomeKind, readTickets, type RunSettings, type TicketRecord, type TicketState, TICKET_STATES } from "../mod/hooks/run-record.ts";

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
  /** This run's outcome kinds by ticket id, from outcomes.json: what tells red together from a red gate, and taken back from held. */
  outcomes?: Record<string, OutcomeKind>;
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
  /** Held tickets whose branch a person has merged by hand: on the base, the ticket still open until the push. */
  mergedByHand?: string[];
  /** Issues opened during the run (by anyone: agents share the person's `gh` token), carrying the triage label and still open (GitHub only). */
  filed?: { id: string; title: string }[];
  /** The run record's last stage and exit code: "base gates" with a non-zero exit is a run that never started anything. */
  stage?: string;
  exitCode?: number | null;
  /** Each base gate's verdict, when the run stopped on red base gates. */
  baseGates?: { gate: string; ok: boolean }[];
  /** The run settings the last turn's record carries; absent from an older kit's record. */
  settings?: RunSettings;
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

/** `probe` is the process check (src/live-runs.ts `commandOf`); a test passes its own. */
export const gather = async (project: Project, probe: Probe = commandOf): Promise<Facts> => {
  const root = project.root;
  const base = project.baseBranch;
  const run = JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8"));
  const tickets = readTickets(run);
  // The asking process itself is neither another live run nor a killed one: it is summing itself
  // up, before its exit writes the end.
  const alive = liveness({ record: run, self: process.pid }, probe);
  const live = alive.state === "live";

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
  const byHand = Object.keys(changed).filter((id) => changed[id] === 0 && mergedByHand(root, base, id));

  // Issues opened during the run: open, carrying the triage label, created between its start
  // and its end. Agents file with the person's own token, so the author cannot say who opened
  // one; the report says "opened", never "filed by an agent". A run still going has no end yet
  // (each autonomy turn writes a finishedAt and the run goes on), and one that is only now
  // summing itself up has not written its own, so the window closes only for a finished run:
  // otherwise `sandcastle report` would list whatever a person opens afterwards, every time.
  // Dates are compared here, not with a shell `date`, which differs on macOS.
  let filed: { id: string; title: string }[] = [];
  if (project.tracker.kind === "github") {
    try {
      const open = JSON.parse(sh("gh", ["issue", "list", "--state", "open", "--label", project.tracker.triage, "--limit", "500", "--json", "number,title,createdAt"], root)) as { number: number; title: string; createdAt: string }[];
      const from = Date.parse(run.startedAt);
      const to = alive.state === "finished" && run.finishedAt ? Date.parse(run.finishedAt) : Infinity;
      filed = open.filter((i) => Date.parse(i.createdAt) >= from && Date.parse(i.createdAt) <= to).map((i) => ({ id: String(i.number), title: i.title }));
    } catch {
      filed = [];
    }
  }

  // Only this run's: an entry an earlier run wrote says nothing about this run's tickets.
  const outcomes = Object.fromEntries(
    Object.entries(readOutcomes(root)).flatMap(([id, o]) => (o.run === run.startedAt && o.kind ? [[id, o.kind]] : [])),
  );

  const timingsFile = join(root, ".sandcastle/logs/timings.jsonl");
  const timed = existsSync(timingsFile) ? tokensFromTimings(readFileSync(timingsFile, "utf8"), run.startedAt) : undefined;

  return {
    base,
    tracker: project.tracker.kind,
    started: run.startedAt,
    finished: run.finishedAt,
    live,
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
    blocked,
    blockCheck,
    ahead: Number.isNaN(ahead) ? undefined : ahead,
    upstream,
    standing,
    keptWorktrees: run.keptWorktrees ?? [],
    dryRunCheck: run.dryRunCheck,
    stopped: run.stopped,
    changed,
    mergedByHand: byHand,
    filed,
    stage: run.stage,
    exitCode: run.exitCode,
    baseGates: run.baseGates,
    settings: run.settings && typeof run.settings === "object" ? run.settings : undefined,
  };
};

const LEVELS = [0, 1, 2, 3, "drain"];

/**
 * The run's settings as one line, and the hints its own facts call for. Only a field the record
 * holds is said, and a value of the wrong type is as unknown as a missing one: the record is a
 * file in a repository. A hint is a switch that would have changed this run's outcome, never a
 * catalogue: nothing here is said when nothing calls for it.
 */
export const settingsLines = (f: Facts): string[] => {
  const s = f.settings;
  if (!s || typeof s !== "object") return [];
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
  if (!items.length) return [];

  const lines = [`Settings: ${items.join(" · ")}`];
  const again = level === 0 && !f.next ? rerunnable(f) : undefined;
  const left = again ? [...new Set([...again.conflicted, ...again.unblocked])] : [];
  if (left.length) {
    lines.push(
      `Autonomy 0 makes one turn, and ${left.map(refOf).join(" ")} could run again: \`AUTONOMY_LEVEL=2\` (or \`drain\`) lets one \`sandcastle run\` take ` +
        `${left.length === 1 ? "it" : "them"} without starting it by hand.`,
    );
  }
  if (noReading) lines.push("The usage guard had no reading, so this run was not guarded: check your usage yourself.");
  return lines;
};

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const span = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/** The closing summary as Markdown-ish text, every section present. */
export const render = (f: Facts, plain = false): string => {
  const ids = (states: TicketState[]) => Object.entries(f.tickets).filter(([, t]) => !!t.state && states.includes(t.state)).map(([id]) => id);
  const name = (id: string) => `${refOf(id)}${f.tickets[id]?.title ? ` ${f.tickets[id].title}` : ""}`;
  const list = (xs: string[]) => xs.map(refOf).join(" ") || "none";
  const merged = ids(["merged"]);
  // Merged, but the tracker refused the close: the work is on base, the ticket still open.
  const notClosed = merged.filter((id) => f.tickets[id].closeFailed);
  // Merged with an acceptance criterion knowingly left undone: the ticket was left open on purpose.
  const partly = merged.filter((id) => f.tickets[id].unmet);
  const closed = merged.filter((id) => !notClosed.includes(id) && !partly.includes(id));
  // Merged with green gates, but the reviewer said no gate exercises the change. Only merged
  // tickets: a held or red one is already in front of a person, and a dry run merges nothing.
  const ungated = merged.filter((id) => f.tickets[id].ungated);
  // Held work a person has merged by hand: on the base already, so not theirs to merge or redo; the push closes it.
  const byHand = ids(["held"]).filter((id) => f.mergedByHand?.includes(id));
  const held = ids(["held"]).filter((id) => !byHand.includes(id));
  // Held with nothing on its branch: an agent handed it back, or a person took
  // it before any commit. There is nothing to review or merge - only a question.
  const handedBack = held.filter((id) => f.changed[id] === 0);
  // Marked for a human by a person mid-run: they took it; the branch is only there if it helps.
  const takenBack = held.filter((id) => !handedBack.includes(id) && f.outcomes?.[id] === "taken back");
  const heldWork = held.filter((id) => !handedBack.includes(id) && !takenBack.includes(id));
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
    (!!f.killed || (!!f.finished && f.stage !== "report" && typeof f.exitCode === "number" && f.exitCode !== 0));
  const cut = early ? Object.keys(f.tickets).filter((id) => sectionOf(f.tickets[id].state) === "working" && !(f.dryRun && f.tickets[id].state === "ready")) : [];
  const unstarted = early ? ids(["queued"]).filter((id) => !requeued.includes(id)) : [];
  const notStarted = ids(baseRed ? ["queued", ...LEFT] : LEFT).concat(unstarted);
  const nochange = ids(["nochange"]);
  // Finished, but the commit was refused: the work sits in a kept worktree.
  const uncommitted = ids(["uncommitted"]);
  const keptAt = (id: string) => f.keptWorktrees.find((k) => k.issue === id)?.path ?? f.tickets[id].note?.replace(/^work left uncommitted in /, "") ?? "its kept worktree";
  const withdrawn = ids(["withdrawn"]);
  const stoppedIds = ids(["stopped"]);
  // A dry run's green branches end as "ready": they would have merged.
  const wouldMerge = f.dryRun ? ids(["ready"]) : [];
  // Withdrawn before its sandbox started: someone's decision, not an attempt.
  const attempted = baseRed ? 0 : Object.values(f.tickets).filter((t) => sectionOf(t.state) && !LEFT.includes(t.state!) && !(t.state === "withdrawn" && !t.started)).length - unstarted.length;
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
      `${f.dryRun ? `${wouldMerge.length} would merge` : `${merged.length} merged`} - ${held.length + uncommitted.length + new Set([...notClosed, ...partly, ...ungated]).size} need you - ${fixing.length} need fixing - ` +
      // Its own count, and only when there is one: a person triages these, no ticket of the run needs them.
      `${(f.filed ?? []).length ? `${(f.filed ?? []).length} to triage - ` : ""}` +
      `${notStarted.length} not started${f.tokenTotal ? ` - tokens ${tokenLine(f.tokenTotal)}` : f.tokens ? ` - tokens ${f.tokens}` : ""}`,
    baseRed
      ? `Base gates: red - ${f.baseGates?.filter((g) => !g.ok).map((g) => g.gate).join(", ") || "failing gates not recorded; see .sandcastle/logs/base-gates.log"}`
      : f.verify === undefined || f.verify === null
      // null: the run ended and chose not to (fewer than two merges this run - a
      // ticket closed as merged earlier merges nothing); undefined: it never got there.
      ? `Merged ${f.base} not re-gated (${f.verify === null ? "fewer than two branches merged in this run" : early ? "the run ended before it got there" : "no result recorded"}).`
      : f.verify.green
        ? `Merged ${f.base} re-gated: all ${f.gateCount} gates green.`
        : `Merged ${f.base} re-gated: RED TOGETHER (${f.verify.line}) - do not push ${f.base} until it is fixed. Output: .sandcastle/logs/verify-gates.log`,
  );
  const models = Object.entries(f.byModel ?? {});
  if (models.some(([model]) => model !== NO_MODEL)) {
    const size = (t: Tokens) => t.input + t.cacheWrite + t.cacheRead + t.output;
    out.push(`Tokens by model: ${models.sort(([, a], [, b]) => size(b) - size(a)).map(([model, t]) => `${model} ${tokenLine(t)}`).join(" · ")}`);
  }
  out.push(...settingsLines(f));
  if (f.stopped) out.push(f.stopped);
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
  if (wouldMerge.length) {
    // Each branch was gated alone; whether they merge together is a separate question.
    const together = wouldMerge.length > 1 ? " Each was gated on its own: `sandcastle preview` shows which would conflict with each other." : "";
    done.push(`Dry run - green, would merge: ${list(wouldMerge)}. Nothing was merged or closed.${together}`);
  }
  // A warning on a ticket that landed: the line is agent-written, so nothing was held for it.
  for (const id of merged.filter((id) => f.tickets[id].overrun?.length)) done.push(`${name(id)} - beyond Touches: ${overrunPaths(f.tickets[id].overrun!)}`);
  if (byHand.length) done.push(`${byHand.length} held, merged by hand; closes on push: ${list(byHand)}`);
  if (nochange.length) done.push(`Nothing to change: ${list(nochange)} - left open, with the agent's evidence in a comment`);
  // Someone's decision during the run; its branch stands in case they want it.
  for (const id of withdrawn) {
    const kept = f.standing.includes(`agent/issue-${id}`) ? ` (branch agent/issue-${id} kept)` : "";
    done.push(`Not landed, as the tracker now says: ${name(id)} - ${f.tickets[id].note ?? "withdrawn"}${kept}`);
  }
  // Changelog lines the agents suggested (`changelog: true`), for the tickets that landed: the
  // maintainer writes the entries from them. A line starting with none of the three words is a Changed.
  const lines = merged.flatMap((id) => (f.tickets[id].changelog ?? []).map((line) => ({ id, line })));
  if (lines.length) {
    done.push("Changelog lines the agents suggested:");
    for (const group of ["Added", "Changed", "Fixed"]) {
      const mine = lines.filter(({ line }) => (/^(Added|Changed|Fixed):/.exec(line)?.[1] ?? "Changed") === group);
      for (const { id, line } of mine) done.push(`  ${group}: ${line.replace(/^(Added|Changed|Fixed):\s*/, "")} (${refOf(id)})`);
    }
  }
  section(h("## ✅ Done", "## Done"), done);

  // Needs you
  section(
    h("## 🙋 Needs you", "## Needs you"),
    [
      ...uncommitted.map(
        (id) =>
          `- ${name(id)} - finished but not committed - the work is in ${keptAt(id)}. Fix what refused the commit (the agent's comment says), then \`sandcastle requeue <ticket>\`: the next run reuses that worktree. Or commit it there yourself.`,
      ),
      ...heldWork.flatMap((id) => {
        const t = f.tickets[id];
        const size = f.changed[id] !== undefined ? ` - ${f.changed[id]} file(s)` : "";
        const why = t.files?.length ? `changes ${t.files.join(", ")}` : (t.note ?? "held");
        // A criterion the agents left undone travels with the branch: whoever lands it by hand sees it first
        // (`sandcastle land` merges it as partly done and leaves the ticket open).
        const unmet = t.unmet ? ` - criterion unmet: ${t.unmet}${t.unmet.endsWith("…") ? ` (cut short - full text in the agents' logs, .sandcastle/logs/agent-issue-${id}-*.log)` : ""}` : "";
        return [`- ${name(id)} - ${why}${size}${unmet}`, `  review: git log -p ${f.base}..agent/issue-${id}   merge: git merge --no-ff agent/issue-${id}`];
      }),
      ...takenBack.map((id) => `- ${name(id)} - ${f.tickets[id].note} - branch agent/issue-${id} has the agents' work, if it helps`),
      ...handedBack.map((id) => `- ${name(id)} - ${f.tickets[id].note ?? "held"}, no commits - read the agent's comment: do it yourself and close the ticket, or answer its question and requeue it`),
      // The next run finds its own merge message and closes the ticket, so
      // nobody should merge or redo the work.
      ...notClosed.map(
        (id) => `- ${name(id)} - merged, but closing the ticket failed: ${f.tickets[id].closeFailed} - the next \`sandcastle run\` closes it, or close it by hand`,
      ),
      // The criterion is the agent's own words, cut at the cap like an ungated note. The implementer may
      // have said it, not a reviewer, so the pointer names every agent log of the ticket.
      ...partly.map((id) => {
        const note = f.tickets[id].unmet ?? "";
        const more = note.endsWith("…") ? ` (cut short - full text in the agents' logs, .sandcastle/logs/agent-issue-${id}-*.log)` : "";
        return `- ${name(id)} - merged, partly done: ${note}${more} - the ticket is still open, and the next \`sandcastle run\` picks up the remainder`;
      }),
      // A note cut at the cap ends with "…": the whole of it is only in the reviewer's log.
      ...ungated.map((id) => {
        const note = f.tickets[id].ungated ?? "";
        const more = note.endsWith("…") ? ` (cut short - full text in .sandcastle/logs/agent-issue-${id}-review-${id}.log)` : "";
        return `- ${name(id)} - merged - check by hand: ${note}${more}`;
      }),
      ...(f.filed ?? []).map((i) => `- #${i.id} ${i.title} - opened during this run: triage it, then queue or close it`),
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
    ...requeued.map((id) => `Requeued: ${name(id)}${f.tickets[id].requeued ? ` - ${f.tickets[id].requeued}` : ""} - still queued for the next run`),
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
  // First: the work is done, and a further turn or a redo would only repeat the refusal.
  if (uncommitted.length) next.push(`Commit the finished work of ${list(uncommitted)}: fix what refused the commit (a hook, a full disk, signing), then \`sandcastle requeue <ticket>\` - the next run reuses the kept worktree - or commit it there yourself (paths under Needs you).`);
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
  if (partly.length) next.push(`Read what is left on ${list(partly)} (merged, partly done, ticket open): the next \`sandcastle run\` picks up the remainder, or finish it yourself and close the ticket.`);
  if (ungated.length) next.push(`Check ${list(ungated)} by hand: merged, but no gate exercises the change (what to check is under Needs you).`);
  const lone = fixing.filter((id) => ![...sameTest, ...sameFile].some(([, w]) => w.includes(id)));
  // These tickets keep their queue label (the kit only comments on them), so "requeue" sent operators
  // looking for a step that does not exist; the next run resumes the kept branch instead.
  // `sandcastle land` merges and gates the way a run does; a hand-written merge skips both.
  if (lone.length) next.push(`Look at ${list(lone)}: still queued - add a comment for the implementer if it helps, and the next \`sandcastle run\` resumes its branch; or fix the branch yourself and land it: \`sandcastle land ${lone.length === 1 ? lone[0] : "<n>"}\`.`);
  // Never closed by the kit (the agent may be wrong), and still queued: every later run would pay for it again.
  if (nochange.length) next.push(`Read the agent's comment on ${list(nochange)} (nothing to change): close it if the evidence holds, or add what is missing - while it stays queued, every \`sandcastle run\` tries it again.`);
  if (f.runnable.length) next.push(`Run again for the ${f.runnable.length} ticket(s) this run unblocked: \`sandcastle run\`.`);
  if (skipped.length) next.push(`Run again for the ${skipped.length} ticket(s) that never started.`);
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
    ? [`Autonomy level ${f.next.level} runs turn ${f.next.turn} of ${f.next.level === "drain" ? `at most ${DRAIN_CAP}` : f.next.level} next for ${f.next.tickets.map(refOf).join(", ")}; nothing to do yet.`, ...(push ? [push] : [])]
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
