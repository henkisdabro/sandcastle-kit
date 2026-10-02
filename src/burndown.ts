// The issue-burndown orchestrator, for any project with a `.sandcastle/config.ts`.
//
//   Phase 0  Base    - every gate on the base commit, in the image; a red one
//                      stops the run before any agent starts (gates.ts).
//   Phase 1  Fan out - one sandbox per queued issue, own branch: implement,
//                      review (and optionally cross-review) on the same warm
//                      sandbox.
//   Phase 2  Gate    - the project's gates, run by the ORCHESTRATOR via
//                      exec(), never self-reported by an agent. A red gate
//                      gets a bounded repair pass fed its output, and a
//                      repair that turns it green is reviewed again.
//   Phase 3  Land    - on one worker beside the pipelines, each green branch merges
//                      to the base branch as it goes green, and its issue is
//                      closed with a comment. A branch that does not hold the
//                      base's tip is merged and gated in a sandbox first. Red
//                      branches, and green ones that change hooks/CI/install
//                      scripts, are left standing.
//   Phase 4  Verify  - the gates once more on the merged base branch, because
//                      two branches green on their own can be red together.
//
// Environment: TICKETS=1,2 (ISSUES is the older name; instead of the queue label), CONCURRENCY, DRY_RUN=1 (`sandcastle run 1 2
// --dry --concurrency N` set the same three),
// SANDCASTLE_TEST_RED_GATE=1, SKIP_BASE_GATES=1, plus the model variables in agents.ts and the
// machine-wide limits in pool.ts.

import { createSandbox } from "@ai-hero/sandcastle";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, crossReview, implAgent, implementNote, reviewWithFallback, ticketOverride } from "./agents.ts";
import type { Level } from "./autonomy.ts";
import type { Project } from "./config.ts";
import { BaseRedError, type Gate, failingTests, failureKey, gateBase, gateLine, gateMs, gateRed, requireGreenBase, runGates as gatesIn, VERIFY_LOG, writeGateLog } from "./gates.ts";
import { blockedNote, blockerProblems, blockerResolver, blockerTicket, commentBlockLine, commentOnlyBlocks, openBlockers, openBlockersNow, refLabel, type Blocker } from "./blockers.ts";
import { disableHostGitGc, disableHostGitHooks, gitFingerprint, largeFiles, lockRun, pinHostGitConfig, protectedChanges } from "./guard.ts";
import { checkHooks, hiddenReferences, reportHookCheck, unmatched, unmatchedLines, writePlan } from "./lean.ts";
import { IN_HERDR, openSandboxView, sandboxPanes } from "./herdr.ts";
import { registerRun } from "./live-runs.ts";
import { isTicketState, type RunRecord, type TicketRecord, type TicketState } from "../mod/hooks/run-record.ts";
import { limit, usage, wholeNumber, withSlot } from "./pool.ts";
import {
  addTokens, agentLogging, archiveFinishedLogs, assertCleanBase, gatesLog, keepAwake, landOnlyHead, markLog, narrowReviewBase, NO_TOKENS, openStatusPane, preflight, recordHead, recordOutcomes,
  namedTicketsFromEnv, recordRun, renderPrompts, runTokens, type Tokens, tokenBrief, estimate, tokenLine, typicalTimes, usedArgs, logOwner,
} from "./run.ts";
import { strayChanges, strayNote } from "./resolution.ts";
import { resolveVersions, versionsLine } from "./versions.ts";
import { credentials, ensureImage, errorLine, ownCommits, reapOrphans, sandboxConfig, sh } from "./sandbox.ts";
import { LATEST_ISSUE, ensureTriageLabel, makeTracker, refOf, type Ticket, type Tracker } from "./tracker.ts";
import { closingReport, summary } from "./report.ts";
import { notifyCommand, runNotify } from "./notify.ts";
import { usageLine, usageStop } from "./usage.ts";
import { lockWorktree, releaseBranchWorktree, unlockAll, unlockWorktree } from "./worktree-lock.ts";
import { OperatorError } from "./errors.ts";
import { hostIdentity, regensFor, resolveGenerated, shq } from "./generated.ts";
import { sandboxOpener } from "./land.ts";
import {
  accountLanding, carriedBranch, carriedMergeLine, conflictLine, createHostGit, createRequeueRecord, greenCarriedLine, type LandContext, landingLines, landingWork, newLandings, pipelineWorkers, slotTurn, STOPPED_GREEN,
  trackerMade, withdrawnRecord,
} from "./landing.ts";
import { type Attempted, type Change, createSchedule, type Ending, fileShareLine, fileWaitNote, type HoldChange, type Start, type StopCause, stoppedWaitNote, type TicketFiles } from "./schedule.ts";
import { expandTouches, parseTouches, unmergeableFiles } from "./touches.ts";
import { blockerChain } from "./lint.ts";

// Where they lived before landing.ts; callers and tests still import them from here.
export { abortLanding, closeComment, mergeBranch } from "./landing.ts";

type Issue = Ticket;
type Outcome = {
  issue: string;
  branch: string;
  // "green", never "shipped": the pane titles said shipped while nothing had
  // landed, and the status table said queued - a run read as going in circles.
  status: "green" | "gate-failed" | "nochange" | "merged-earlier" | "held";
  /** Why the kit held a finished branch for a person (`held`): nothing was handed back by an agent. */
  heldNote?: string;
  commits: number;
  /** The branch tip the gates passed on; landing refuses a branch that moved since. */
  head?: string;
  reviewCommits: number;
  repairs: number;
  gates: Gate[];
  /** Test ids the last red gate named. */
  failing?: string[];
  /** Its branch had work from an earlier run: landing takes it first. */
  carried?: boolean;
  /** Repaired green, but the review of the repair failed: held, never merged unreviewed. */
  unreviewed?: boolean;
  /** What a reviewer said no gate exercises (its <ungated> line), for the closing summary. */
  ungated?: string;
};

/**
 * The kept worktree of a pipeline that ended with no commits: the agent finished and its commit
 * was refused (a git hook, a full disk, a signing failure), so Sandcastle kept the worktree for
 * its uncommitted files. That is not "nothing to change" - the work exists.
 */
export const keptFor = (o: Pick<Outcome, "issue" | "status" | "commits">, kept: { issue: string; path: string }[]) =>
  o.status === "nochange" && o.commits === 0 ? kept.find((k) => k.issue === o.issue) : undefined;

/** The run's own steps, timed beside a ticket's states: they are the run line's `stage`, never a ticket's state. */
type Stage = "image" | "preflight" | "hook check" | "base gates" | "verify";

/** The record of a pipeline that added no commits: uncommitted work first, then a hand-back, then nothing to change. */
export const noCommitRecord = (o: Pick<Outcome, "issue" | "status" | "commits">, kept: { issue: string; path: string }[], root: string, handedBack: boolean): TicketRecord => {
  const k = keptFor(o, kept);
  if (k) {
    // Shown relative to the project, as the worktrees live in .sandcastle/worktrees/<name>.
    const inside = relative(root, k.path);
    const where = inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : k.path;
    return { state: "uncommitted", note: `work left uncommitted in ${where}` };
  }
  return { state: "nochange", note: handedBack ? "handed back - for a human" : "nothing to change" };
};

// A branch's outcome as the status view's row shows it, before landing.
const outcomeText = (o: Outcome) =>
  o.status === "gate-failed"
    ? `gate red: ${gateLine(o.gates.filter((g) => !g.pass))}`
    : o.status === "green"
      ? "green - waiting to land"
      : o.status === "held"
        ? `needs a human: ${o.heldNote ?? "held"}`
        : o.status;

// The ticket's state for a pipeline that ended without a green branch or a red gate. A ticket the
// kit held says so from the first write; "handed back" is only for an agent that handed it back.
export const settledUnlanded = (o: Pick<Outcome, "status" | "heldNote">, handedBack: boolean): TicketRecord =>
  o.status === "held"
    ? { state: "held", note: o.heldNote ?? "held for a human" }
    : { state: "nochange", note: handedBack ? "handed back - for a human" : "nothing to change" };

// What an issue's pane and sidebar entry say when its pipeline ends - the
// status table's words, so the two never disagree.
const finishWord = (o: Outcome) =>
  ({ green: "ready to land", "gate-failed": "gate red", nochange: "no change", "merged-earlier": "ready to land", held: "needs a human" })[o.status];

// The one comment a ticket that did not land gets: the conflict (the other
// ticket and the files), the agents' report, or both - never two comments.
export const notLandedComment = (
  report: string | undefined,
  conflict: { branch: string; base: string; files: string[]; with: string[] } | undefined,
  red?: { branch: string; base: string; with: string[]; gates: string[] },
): string | undefined => {
  if (red) {
    return (
      `Sandcastle ran this ticket and did not land it: \`${red.branch}\` was green on its own, but merged into \`${red.base}\` the gates were red (${red.gates.join(", ")}). ` +
      (red.with.length ? `Landed on \`${red.base}\` since this branch forked: ${red.with.map(refOf).join(", ")}. ` : "") +
      `Nothing was merged. The next run merges \`${red.base}\` into the branch and tries again.` +
      (report === undefined ? "" : `\n\nWhat the agents reported:\n\n${report}`)
    );
  }
  if (!conflict) return report === undefined ? undefined : `Sandcastle ran this ticket and did not land it. What the agents reported:\n\n${report}`;
  return (
    `Sandcastle ran this ticket and did not land it: merging \`${conflict.branch}\` into \`${conflict.base}\` conflicted (${conflictLine(conflict)}). ` +
    `The next run merges \`${conflict.base}\` into the branch and tries again.` +
    (report === undefined ? "" : `\n\nWhat the agents reported:\n\n${report}`)
  );
};

// What a spent plan allowance leaves at the end of an agent's log.
const LIMIT = /out of usage credits|usage limit|limit reached/i;

// A fence one backtick longer than any run inside, so gate output cannot
// close it and carry on as prompt text.
const fence = (text: string) => {
  const f = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${f}\n${text}\n${f}`;
};

// The reviewer's `<ungated>...</ungated>` line: what a person should check because no gate
// exercises the change. Same rules as `tags()` in the pipeline - the last tag wins, an empty
// one or the echoed placeholder "..." does not count - and the text is one line, cut to
// UNGATED_MAX at a word with a closing "…" (the report then points at the review log).
export const UNGATED_MAX = 2000;
export const cutAtWord = (text: string, max: number): string => {
  if (text.length <= max) return text;
  // Room for the "…"; back up to the last space so no word is left half-written, unless
  // the head is one unbroken run (a path or URL), which is cut where it stands.
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
};
export const ungatedOf = (text: string): string | undefined => {
  const last = [...text.matchAll(/<ungated>([\s\S]*?)<\/ungated>/g)].at(-1);
  const said = last?.[1].replace(/\s+/g, " ").trim();
  return said && said !== "..." ? cutAtWord(said, UNGATED_MAX) : undefined;
};

/** The tickets `TICKETS` (or `ISSUES`, its older name; or `sandcastle run 12 15`) names, refused before anything starts when one is closed. */
export const namedTickets = (tracker: Tracker, list: string): Issue[] =>
  list.split(",").map((n) => {
    const t = tracker.get(n.trim());
    if (!t.open) throw new OperatorError(`${tracker.ref(t.id)} is closed, so a run would not work on it. Leave it out, or reopen it first.`);
    return t;
  });

/** The tickets a turn runs plus the rest of the queue: a named ticket not queued (hand-picked) stays, as it was. */
export const wholeQueue = (tracker: Tracker, named: Issue[]): Issue[] => [...named, ...tracker.queued(false).filter((t) => !named.some((n) => n.id === t.id))];

/**
 * Every queued ticket with an open blocker, whether or not this turn runs it. A later autonomy
 * turn names its tickets in `TICKETS`, and a `waiting` built from those alone loses every
 * dependant outside the list - so the closing summary never says they were freed.
 */
export const waitingTickets = async (project: Project, tracker: Tracker, whole: Issue[]): Promise<{ issue: string; on: string[] }[]> =>
  [...(await openOnQueue(project, tracker, whole))].map(([id, on]) => ({ issue: id, on: on.map(refLabel) }));

/** The open blockers of each ticket in `whole` that has any, in queue order. */
export const openOnQueue = async (project: Project, tracker: Tracker, whole: Issue[]): Promise<Map<string, Blocker[]>> => {
  const resolve = blockerResolver(project, tracker, new Set(whole.map((i) => i.id)));
  const open = await Promise.all(whole.map((i) => openBlockers(project, tracker, resolve, i)));
  return new Map(whole.flatMap((i, at) => (open[at].length ? [[i.id, open[at]] as const] : [])));
};

/**
 * The files the ticket's existing branch changes. Three dots: its own changes since it forked or
 * last merged the base, so work that landed on the base meanwhile is not counted against it. No
 * branch (a new ticket) or an empty diff means no files. `--no-renames` lists both ends of a rename.
 */
export const branchFiles = (root: string, base: string, id: string): string[] => {
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/agent/issue-${id}`], root);
    return sh("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...agent/issue-${id}`], root).split("\0").filter(Boolean);
  } catch {
    return [];
  }
};

/** What a ticket will change: its branch's files and its `Touches:` line (src/touches.ts), and which of them git cannot merge. */
export const ticketFiles = (project: Project, ticket: Issue): TicketFiles => {
  const base = project.baseBranch;
  const all = [...new Set([...branchFiles(project.root, base, ticket.id), ...expandTouches(project.root, base, parseTouches(ticket.body ?? ""))])];
  return { all, unmergeable: unmergeableFiles(project.root, base, all, project.generated ?? []) };
};

/**
 * A ticket in flight changes files its first reading did not see: its branch gains a lockfile
 * change after the start. Adds the branch's files now to what was read, and recomputes which of
 * them git cannot merge. One `git diff` and, for the sizes, one cached tree read.
 */
export const refreshFiles = (project: Project, ticket: Issue, files: TicketFiles): TicketFiles => {
  const all = [...new Set([...files.all, ...branchFiles(project.root, project.baseBranch, ticket.id)])];
  return { all, unmergeable: unmergeableFiles(project.root, project.baseBranch, all, project.generated ?? []) };
};

/**
 * The run record's side of the file hold. `start`: each ticket `createSchedule` parked behind a file
 * is said and put on `waiting` (before the run record exists), and each pair that starts together
 * sharing a mergeable file is named. `tell`: what the scheduler tells of the hold as the run goes -
 * a ticket that starts, one that waits (and for whom now), one left for the next run - written to
 * the record, with `waiting` naming the ticket in flight each waits for now, never one that is gone.
 */
export const createHoldRecord = (o: { waiting: { issue: string; on: string[] }[]; ref(id: string): string; say(line: string): void }) => {
  // Every ticket started so far: `waiting` is the start-of-run list, so each write filters against all of them.
  const started = new Set<string>();
  type Record = { ticket(id: string, fields: TicketRecord): void; update(fields: RunRecord): void };
  const write = (run: Record, fields: RunRecord = {}) => run.update({ waiting: o.waiting.filter((w) => !started.has(w.issue)), ...fields });
  // What the ticket waits for: the ticket that holds its file now (`holder`), not the one it was
  // parked behind first. With no holder left (a stopped run) `was` is dropped from it, and a ticket
  // that waits for nothing more leaves the list.
  const waitsFor = (run: Record, id: string, was: string | undefined, holder?: string) => {
    const at = o.waiting.findIndex((w) => w.issue === id);
    const on = holder ? [o.ref(holder)] : at >= 0 ? o.waiting[at].on.filter((b) => b !== (was && o.ref(was))) : [];
    if (at >= 0) {
      if (on.length) o.waiting[at].on = on;
      else o.waiting.splice(at, 1);
    } else if (on.length) o.waiting.push({ issue: id, on });
    write(run);
  };
  return {
    start(candidates: readonly Start<{ id: string }>[]) {
      for (const { ticket, file, shares } of candidates) {
        if (file) {
          o.waiting.push({ issue: ticket.id, on: [o.ref(file.with)] });
          o.say(`  ${o.ref(ticket.id)} ${fileWaitNote(o.ref, file)}`);
        }
        for (const share of shares ?? []) o.say(`  ${fileShareLine(o.ref, ticket.id, share)}`);
      }
    },
    tell(run: Record, c: HoldChange) {
      switch (c.kind) {
        case "started":
          started.add(c.id);
          o.say(`  ${o.ref(c.id)} starts: ${c.after.kind === "blockers" ? "its last blocker has landed" : `${o.ref(c.after.freed)} is done with the file they both change`}`);
          for (const share of c.shares) o.say(`  ${fileShareLine(o.ref, c.id, share)}`);
          run.ticket(c.id, { state: "queued", note: null });
          write(run, { stage: "running" });
          return;
        case "waits":
          if (c.parked) o.say(`  ${o.ref(c.id)} ${fileWaitNote(o.ref, c.wait)}`);
          run.ticket(c.id, { state: "blocked", note: fileWaitNote(o.ref, c.wait) });
          waitsFor(run, c.id, undefined, c.wait.with);
          return;
        case "next run":
          run.ticket(c.id, { note: stoppedWaitNote(o.ref, c.wait) });
          waitsFor(run, c.id, c.freed, c.wait?.with);
      }
    },
  };
};

/** The record of a ticket whose label refuses it, found as it would have started. */
export const refusedRecord = (reason: string): TicketRecord => ({ state: "skipped", note: reason.replace(/^NOT STARTED: /, "not started: ") });

let unlockOnExit = false;

/** False when the queue was empty or all of it waiting: nothing ran, so there is no turn to follow. */
export const burndown = async (project: Project, turn?: { level: Level; turn: number }): Promise<boolean> => {
  const DRY_RUN = process.env.DRY_RUN === "1";
  // A test of the repair path itself. An agent that can read a gate makes it
  // pass before it exits, so a live run almost never reaches a repair; this
  // counts each ticket's first gate run as red, with an output that says so.
  // Off without repair passes: a forced red nobody repairs would only hold
  // good work back.
  const TEST_RED_GATE = process.env.SANDCASTLE_TEST_RED_GATE === "1" && (project.repair.attempts ?? 1) > 0;
  // Four by default, not one-per-issue. Twelve at once saturated a 15-core
  // machine to load 33 and starved a vitest run into a false gate failure -
  // good work withheld by resource contention rather than by a defect.
  const CONCURRENCY = wholeNumber("CONCURRENCY", process.env.CONCURRENCY ?? project.concurrency, 1);
  const base = project.baseBranch;

  // Fail before spending a single container.
  const notify = notifyCommand();
  disableHostGitHooks();
  disableHostGitGc();
  pinHostGitConfig(project.root);
  assertCleanBase(project);
  lockRun(project);
  reapOrphans(project);

  // The work list lives in the tracker (GitHub labels, or ticket files), never
  // in an agent's context. Named tickets are checked on the host, so a typo or
  // a closed ticket fails here and not inside a sandbox that has already
  // installed its dependencies.
  const tracker = makeTracker(project);
  const ref = tracker.ref;
  const named = namedTicketsFromEnv();
  if (named.note) console.log(named.note);
  const queued: Issue[] = named.list ? namedTickets(tracker, named.list) : tracker.queued();
  if (queued.length === 0) {
    console.log(`No ${project.label} tickets. Queue drained.`);
    return false;
  }

  // An issue whose blocker is still open waits - including a blocker in this
  // same run, which cannot be on base before landing, so the dependent would
  // branch without it. It starts in this run once its last blocker has landed
  // and closed (`dependants`, below). Blockers are GitHub issues
  // and, if the project configures them, Linear issues and task files
  // (blockers.ts); one that cannot be read counts as open.
  // `waiting` covers the whole queue, not only the named tickets, so a later turn still records the dependants.
  const whole = named.list ? wholeQueue(tracker, queued) : queued;
  const wholeOpen = await openOnQueue(project, tracker, whole);
  const held = new Map<string, { ticket: Issue; on: Blocker[] }>(queued.flatMap((i) => (wholeOpen.has(i.id) ? [[i.id, { ticket: i, on: wholeOpen.get(i.id)! }] as const] : [])));
  const waiting = [...wholeOpen].map(([id, on]) => ({ issue: id, on: on.map(refLabel) }));
  for (const w of waiting) console.log(`  ${ref(w.issue)} waits for ${w.on.join(", ")} to close`);
  // A comment is not read as a blocker; say so where the run would start the issue.
  for (const f of await commentOnlyBlocks(project, tracker, queued.map((t) => ({ ...t, queued: true })))) console.log(`  warning: ${commentBlockLine(f)}`);
  // A blocker that can never close (missing, a cycle) holds its ticket for good; an unnamed Linear key lets it start.
  for (const line of await blockerProblems(project, tracker, queued)) console.log(`  warning: ${line}`);
  // A ticket others wait for starts first; otherwise the tracker's order
  // holds. The two blockers of seven waiting tickets once ran last of thirty,
  // so a run stopped early would have left all seven stuck for another run.
  // (Their dependants start in this run, as the blocker lands.)
  const unblocks = (i: Issue) => waiting.filter((w) => w.on.includes(ref(i.id))).length;
  const ready = queued.filter((i) => !waiting.some((w) => w.issue === i.id)).sort((a, b) => unblocks(b) - unblocks(a));
  // A file git cannot merge (a lockfile, a generated file, a minified blob) conflicts at landing
  // whatever the order, so one ticket at a time has it in flight; the others wait for that one to
  // land or leave the run. Files git can merge never hold a ticket: landing and the requeue resolve
  // them, and the start says which tickets will meet. A dry run lands nothing, so it holds nothing.
  // The scheduler decides all of it, here, before the run is recorded.
  const laterOverrides = new Map<string, ReturnType<typeof ticketOverride>>();
  // Every attempt and every landing goes through the scheduler: a bounded fan-out (a sliding pool,
  // not a batch barrier, inside the machine-wide sandbox limit), one landing worker beside it, a
  // first conflict or red sent back once, the file hold, and the release of what waits, as each ticket ends.
  const schedule = createSchedule<Issue, Outcome, Outcome, Blocker>({
    tickets: ready,
    files: DRY_RUN ? undefined : { of: (t) => ticketFiles(project, t), refresh: (t, files) => refreshFiles(project, t, files) },
    // A held ticket that also waits on something outside this run is the next run's. A dry run
    // lands nothing, so it releases nothing.
    blockers: { held: [...held.values()], ticketOf: blockerTicket, ...(DRY_RUN ? {} : { open: openBlockersNow(project, tracker, queued.map((i) => i.id)) }) },
    // Before the run is recorded, the image checked or any sandbox started: a bad label on a ticket
    // that starts now costs nothing. A waiting ticket's label is checked when it is released (it
    // holds that ticket, never the run), but its model is still read now, for the preflight.
    checkLabel: (i) => {
      try {
        laterOverrides.set(i.id, ticketOverride(ref(i.id), i.labels ?? []));
      } catch (error) {
        if (!(error instanceof OperatorError)) throw error;
        return error.message;
      }
    },
  });
  const holds = createHoldRecord({ waiting, ref, say: (line) => console.log(line) });
  holds.start(schedule.start);
  const candidates = schedule.start.map((c) => c.ticket);
  const issues = schedule.start.flatMap((c) => (c.wait ? [] : [c.ticket]));
  const dependants = schedule.start.flatMap((c) => (c.wait === "blockers" ? [c.ticket] : []));
  const parked = schedule.start.flatMap((c) => (c.file ? [{ ticket: c.ticket, wait: c.file }] : []));
  // `order` in run.json: a released ticket queues behind the ones already waiting for a sandbox.
  const order = new Map(candidates.map((t, at) => [t.id, at] as const));
  if (issues.length === 0) {
    console.log("Every queued ticket is waiting on another. Nothing to start.");
    return false;
  }
  const overrides = new Map([...issues.map((i) => [i.id, ticketOverride(ref(i.id), i.labels ?? [])] as const), ...laterOverrides]);
  // Resolved once here: the image, the start lines and run.json all name the same versions.
  const versions = await resolveVersions(project);

  // A dry run lands nothing, so it needs no sandbox slot for it.
  const workers = pipelineWorkers(CONCURRENCY, candidates.length, limit("sandboxes"), !DRY_RUN);
  const capped = workers < Math.min(CONCURRENCY, candidates.length);
  console.log(
    `${candidates.length} ticket(s)${dependants.length ? ` (${dependants.length} start as their blockers land)` : ""}${parked.length ? ` (${parked.length} wait for a file git cannot merge)` : ""}, ${workers} at a time${DRY_RUN ? " [DRY RUN]" : ""} - ${MODELS_LINE}:` +
      (capped ? ` (CONCURRENCY=${CONCURRENCY}, but one of the ${limit("sandboxes")} machine-wide sandbox slots is kept for landing)` : ""),
  );
  for (const i of candidates) {
    const o = overrides.get(i.id) ?? {};
    const own = implementNote(o);
    const later = parked.find((p) => p.ticket.id === i.id);
    console.log(`  ${ref(i.id)} ${i.title}${own}${dependants.includes(i) ? " - waits for a blocker in this run" : later ? ` - ${fileWaitNote(ref, later.wait)}` : ""}`);
  }
  console.log(versionsLine(versions));
  // Sandboxes at once: the estimate's divisor, and the status view's guess at when landing starts.
  const slots = Math.min(workers, limit("sandboxes"));
  const rough = estimate(project, candidates.length, slots, blockerChain(project, tracker, candidates).length);
  if (rough) console.log(rough);
  console.log(`Machine-wide: ${usage()}`);
  console.log(`Keep awake: ${keepAwake()}`);
  if (TEST_RED_GATE) {
    console.log(
      "SANDCASTLE_TEST_RED_GATE=1: each ticket's first gate run counts as red, to test the repair pass. " +
        "Each ticket pays for a repair agent and another full gate run - a test switch, not for real runs.",
    );
  } else if (process.env.SANDCASTLE_TEST_RED_GATE === "1") console.log("SANDCASTLE_TEST_RED_GATE=1 ignored: repair.attempts is 0.");

  // The run is on record and on screen before anything slow starts: a cold
  // image check, preflight and base gates took over three minutes with no
  // view at all, and the chosen issues looked like the rest of the queue.
  // `tickets` is where the status view reads each ticket's state from; a
  // held-back one says whether this run can reach it.
  // Notes are short: the view's activity column is about 30 characters in an 80-column pane.
  const inRun = new Set(candidates.map((c) => c.id));
  // Typed as entries, so `Object.fromEntries` cannot widen a misspelt state to `any`.
  const startTickets: [string, TicketRecord][] = [
    ...issues.map((i): [string, TicketRecord] => [i.id, { state: "queued", order: order.get(i.id), since: Math.floor(Date.now() / 1000), title: i.title }]),
    // `order` too: a released ticket queues behind the ones already waiting for a sandbox.
    ...dependants.map((i): [string, TicketRecord] => [i.id, { state: "blocked", order: order.get(i.id), note: blockedNote(held.get(i.id)!.on, inRun), title: i.title }]),
    // Waiting for a file git cannot merge: starts when the ticket that has it lands or leaves the run.
    ...parked.map((p): [string, TicketRecord] => [p.ticket.id, { state: "blocked", order: order.get(p.ticket.id), note: fileWaitNote(ref, p.wait), title: p.ticket.title }]),
    // Waiting, but not this turn's to run (a later turn's tickets): on record all the same.
    ...[...wholeOpen]
      .filter(([id]) => !candidates.some((c) => c.id === id))
      .map(([id, on]): [string, TicketRecord] => [id, { state: "blocked", note: blockedNote(on, inRun), title: whole.find((q) => q.id === id)?.title }]),
  ];
  const run = recordRun(project, {
    issues: candidates.map((i) => i.id),
    dryRun: DRY_RUN,
    versions: { claude: versions.claude, codex: versions.codex },
    waiting,
    stage: "starting",
    concurrency: slots,
    typical: typicalTimes(project),
    tickets: Object.fromEntries(startTickets),
  }, notify && ((r) => runNotify(notify, project.name, r)));
  // The machine-wide list of live runs (the Herdr tab bar, the Claude Code mod), Herdr or not.
  registerRun(project.root);
  // Released on any exit, Ctrl-C included, so the clean-up command Sandcastle
  // prints for a kept worktree works as printed.
  // Once per process: each turn of an autonomy run would add another listener.
  if (!unlockOnExit) process.on("exit", unlockAll);
  unlockOnExit = true;
  // Inside Herdr, the run's own tab: the status view and, with `herdr.panes: "all"`, one pane per
  // concurrent sandbox, reporting each one's phase. Otherwise (or with the
  // view off) the status view opens beside the caller. Inside Herdr a run
  // with no status view does not start: nobody would see it.
  const view = openSandboxView(project, workers, ref, run.tickets, sandboxPanes(project));
  const statusPane = view.status ?? openStatusPane(project);
  if (IN_HERDR && !statusPane) {
    throw new OperatorError("Could not open the status view in Herdr - nothing was started. Check `herdr pane list`, or run `sandcastle status` yourself.");
  }
  if (statusPane) console.log(`Status view: pane ${statusPane}${view.tab ? ` (tab ${view.tab})` : ""}`);

  // Every step is timed into logs/timings.jsonl, so how long a project's
  // issues take - and where the time goes - is on record rather than guessed.
  // Steps before the agents are issue 0. The same map drives the heartbeat.
  const runId = run.startedAt;
  const timings = join(project.root, ".sandcastle/logs/timings.jsonl");
  const active = new Map<string, { phase: string; since: number }>();
  const took = new Map<string, number>();
  const spent = new Map<string, Tokens>();
  const keptWorktrees: { issue: string; path: string }[] = [];
  // Each issue's step, and when it started, go to run.json's tickets: the
  // status view cannot tell a gate run from the review before it by the logs
  // alone, and a log's age is how long since its last line, not how long the
  // issue has been at this step.
  const timed = async <T>(issue: string, phase: TicketState | Stage, fn: () => Promise<T> | T, note?: string, model?: () => string | undefined): Promise<T> => {
    const since = Date.now();
    active.set(issue, { phase, since });
    if (issue) {
      if (!isTicketState(phase)) throw new Error(`"${phase}" is a step of the run, not a state of ticket ${issue}`);
      // The record first: the view's workspace count reads it.
      run.ticket(issue, { state: phase, ...(phase === "setup" ? { started: Math.floor(since / 1000) } : {}), ...(note ? { note } : {}) });
      view.phase(issue, phase);
    } else run.update({ stage: phase });
    let ok = false;
    let tokens: Tokens | undefined;
    let gateTimes: Record<string, number> | undefined;
    let red: string[] | undefined;
    try {
      const result = await fn();
      tokens = runTokens(result);
      gateTimes = gateMs(result);
      red = gateRed(result);
      // `ok` is pass/fail: a gate run with a red gate is not ok, though it ran.
      ok = !red?.length;
      if (tokens) {
        spent.set(issue, addTokens(spent.get(issue) ?? NO_TOKENS, tokens));
        run.update({ tokens: tokenBrief([...spent.values()].reduce(addTokens, NO_TOKENS)) });
      }
      return result;
    } finally {
      active.delete(issue);
      const m = model?.();
      const line = {
        ts: new Date().toISOString(), run: runId, project: project.name, issue, phase, ms: Date.now() - since, ok,
        ...(m ? { model: m } : {}),
        ...(tokens ? { tokens } : {}),
        ...(gateTimes ? { gates: gateTimes } : {}),
        ...(red?.length ? { red } : {}),
      };
      appendFileSync(timings, JSON.stringify(line) + "\n");
    }
  };

  const image = await timed("", "image", () => ensureImage(project, false, versions));
  const prompts = renderPrompts(project, tracker, DRY_RUN);
  // One entry per distinct override model, naming every ticket that asks for it.
  const extraModels = [...new Set([...overrides.values()].flatMap((o) => (o.model ? [o.model] : [])))].map((model) => {
    const labelled = candidates.filter((i) => overrides.get(i.id)?.model === model).map((i) => ref(i.id));
    return { model, from: `label model:${model} on ${labelled.join(", ")}` };
  });
  await timed("", "preflight", () => preflight(project, image, extraModels));
  const env = credentials(project);
  const usageNote = await usageLine(env);
  if (usageNote) console.log(usageNote);
  archiveFinishedLogs(project);
  // Written next to the prompts; the worktree hook applies it to each sandbox.
  const { plan: lean, file: planFile } = writePlan(project);
  const kept = lean.items.filter((i) => i.kept && i.kind !== "hook").map((i) => `${i.kind}:${i.id}`);
  const dropped = lean.items.filter((i) => i.kind === "hook" && !i.kept).length;
  console.log(
    `Lean: hiding ${lean.items.filter((i) => !i.kept && i.kind !== "hook").length} item(s) the repo would load` +
      (kept.length ? `; keeping ${kept.join(", ")}` : "") +
      `; ${lean.hooks.length} hook(s) kept${dropped ? `, ${dropped} dropped by lean.dropHooks` : ""} (\`sandcastle lean\` for detail).`,
  );
  for (const line of unmatchedLines(unmatched(project, lean))) console.log(`Lean: ${line}.`);
  const refs = hiddenReferences(project.root, lean, project.lean.dropHooks);
  if (refs.length) {
    console.log(
      `Lean warning: ${refs.length} hidden or dropped item(s) are named by files the sandbox keeps (${refs.map((r) => r.path).join(", ")}). ` +
        "If a gate reads one, it fails on every branch - see `sandcastle lean`.",
    );
  }
  // A kept hook that cannot run fails on every tool call of every agent, or
  // silently guards nothing. Stop before any sandbox starts.
  const hookCheck = await timed("", "hook check", () => checkHooks(project, image, lean));
  reportHookCheck(hookCheck, lean.hooks.length);
  if (hookCheck.failures.length) throw new OperatorError("A kept hook cannot run in the image - no sandbox started.");
  if (process.env.SKIP_BASE_GATES === "1") console.log(`SKIP_BASE_GATES=1: the gates on ${base} are not checked first.`);
  else {
    try {
      await timed("", "base gates", () => requireGreenBase(project, image, planFile));
    } catch (error) {
      // The closing summary names the red gates from the record; the stage stays "base gates".
      if (error instanceof BaseRedError) run.update({ baseGates: error.baseGates });
      throw error;
    }
  }
  // What the tracker says about each ticket now, to prove a dry run left it alone.
  const before = DRY_RUN ? tracker.snapshot(issues.map((i) => i.id)) : undefined;
  // Agents label the follow-up issues they file; the sandbox token cannot create the label.
  if (tracker.kind === "github" && !DRY_RUN) ensureTriageLabel(project.tracker.triage);
  run.update({ stage: "running" });
  Object.assign(summary, { due: true, printed: false });
  // The one writer of host git, and the `.git` fingerprint whose base it moves with its own writes.
  const host = createHostGit(project, gitFingerprint(project));
  // The `.git` check after a ticket's pipeline that failed, by ticket: its attempt's result carries
  // it to the scheduler as the cause that stops the run (schedule.ts), which no one else may add.
  const tampered = new Map<string, unknown>();
  // How a cause reads in the skipped tickets' notes and the closing summary.
  const stopWords = (c: StopCause): string => {
    switch (c.kind) {
      case "plan limit":
        return `${ref(c.ticket)} hit the plan's usage limit`;
      case "usage limit":
        return c.line;
      case "tampered":
      case "host failed":
        return "the shared .git changed";
    }
  };
  // What a stopped run throws: a safety stop's own error, which names what moved.
  const stopError = (c: StopCause) => ("error" in c ? c.error : new OperatorError(stopWords(c)));

  // Which gate is running, or that the run waits for a machine-wide slot, and
  // the output as it arrives - a gate run is minutes of nothing otherwise.
  const runGates = (sandbox: Parameters<typeof gatesIn>[1], id: string) => {
    markLog(gatesLog(project, id), runId);
    return gatesIn(project, sandbox, `${ref(id)} gates`, false, {
      wait: () => run.ticket(id, { note: "waiting for a gates slot" }),
      gate: (i, name) => run.ticket(id, { note: `${i + 1}/${project.gates.length} ${name}` }),
      log: gatesLog(project, id),
    });
  };

  const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

  // A run is silent for as long as its agents are, which for a review can be
  // half an hour. One line every five minutes says it is alive and where.
  const heartbeat = setInterval(() => {
    if (!active.size) return;
    const now = Date.now();
    const clock = new Date().toTimeString().slice(0, 5);
    console.log(`[${clock}] working: ${[...active].map(([n, a]) => `${ref(n)} ${a.phase} ${minutes(now - a.since)}`).join(", ")}`);
  }, 5 * 60_000);
  heartbeat.unref();

  // A run that died between merging a branch and closing its issue leaves the
  // issue queued with its work already on base. Re-running it finds nothing
  // to do and reports `nochange`, so the issue would stay open for good. Our
  // own merge message finds it instead - unless someone reopened the issue
  // after that merge, which asks for more work, not for a close. Any doubt
  // (gh unreachable) means a normal run, which is what happened before.
  const mergedEarlier = (issue: string, branch: string) => {
    const found = sh("git", ["log", base, "-1", "--format=%h %cI", "--fixed-strings", `--grep=Merge ${branch} (closes ${ref(issue)})`]);
    if (!found) return undefined;
    const [merge, mergedAt] = found.split(" ");
    return tracker.reopenedSince(issue, Date.parse(mergedAt)) ? undefined : merge;
  };

  // The ticket can change during a long run: closed by hand, taken out of the
  // queue (its label, or its status in a ticket file), or sent to a human.
  // Asked before a pipeline starts, so nobody's allowance goes on work already
  // called off, and again before landing, so none of it merges. A `TICKETS=`
  // ticket that never carried the label started with no status, so its status
  // is not checked.
  const withdrawal = (id: string): { held: boolean; reason: string } | undefined => {
    const now = tracker.get(id);
    const startedAs = candidates.find((i) => i.id === id)?.status;
    if (now.held) return { held: true, reason: "marked for a human during the run" };
    if (!now.open) return { held: false, reason: "ticket closed during the run" };
    if (startedAs === undefined || now.status === startedAs) return undefined;
    return { held: false, reason: now.status === undefined ? "taken out of the queue during the run" : `status changed from ${startedAs} to ${now.status} during the run` };
  };

  // -------------------------------------------------------------------------
  // Phase 1 + 2: implement, review, gate - one pipeline per issue
  // -------------------------------------------------------------------------

  // With a tracker whose agents cannot write to it (ticket files), an agent
  // ends with <report>...</report>, or <blocked>...</blocked> to hand the
  // ticket to a human; the orchestrator posts them, one at a time, after
  // landing, on the landing worker (concurrent commits to the base branch would race on its index).
  const reports = new Map<string, string>();
  // `held`: a ticket the kit held (not one an agent handed back) says why in its run note.
  const notes: { issue: string; kind: "comment" | "hold"; text: string; held?: string }[] = [];
  const addReport = (id: string, heading: string, text: string) =>
    reports.set(id, [reports.get(id), `**${heading}**\n\n${text}`].filter(Boolean).join("\n\n"));
  // The last tag wins, an example or a placeholder ("...") does not count, and
  // a hand-back only stands if nothing was reported after it.
  const tags = (text: string) => {
    const last = (name: string) =>
      [...text.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))]
        .map((m) => ({ text: m[1].trim(), at: m.index! }))
        .filter((m) => m.text && m.text !== "...")
        .at(-1);
    const report = last("report");
    const blocked = last("blocked");
    return blocked && (!report || blocked.at > report.at) ? { blocked: blocked.text } : { report: report?.text };
  };

  // A later run skips work a branch already passed (see recordHead). A dry run's
  // work must not change what a real run skips, and a failed write never fails
  // the ticket: the cost is only that a re-run runs it in full.
  const noteHead = (id: string, branch: string, fields: { reviewed?: string; green?: string }) => {
    if (DRY_RUN) return;
    try {
      recordHead(project.root, id, { branch, ...fields }, runId);
    } catch (error) {
      console.log(`${ref(id)}: could not record its head (${String(error).split("\n")[0].slice(0, 160)}); a re-run runs it in full.`);
    }
  };

  const pipeline = async (issue: Issue): Promise<Outcome> => {
    const branch = `agent/issue-${issue.id}`;
    // The ticket's own implementer, for the implement and repair passes only.
    const own = overrides.get(issue.id) ?? {};
    const implModel = own.model ?? IMPL_MODEL;
    const promptArgs = { ISSUE_NUMBER: issue.id, TICKET: ref(issue.id), ...tracker.promptArgs(issue.id) };
    const merge = mergedEarlier(issue.id, branch);
    if (merge) {
      return { issue: issue.id, branch, status: "merged-earlier", commits: 0, reviewCommits: 0, repairs: 0, gates: [], head: merge };
    }
    view.claim(issue.id, issue.title);

    const started = Date.now();
    releaseBranchWorktree(branch);
    // From here the agent commits to the branch; the `.git` check lets it move.
    host.begin(branch);
    const sandbox = await timed(issue.id, "setup", () =>
      createSandbox({ branch, baseBranch: base, ...sandboxConfig(project, image, planFile) }),
      requeuedAs.get(issue.id),
    ).catch(async (error) => {
      await host.settle(branch, `after ${ref(issue.id)}`).catch(() => {});
      throw error;
    });

    let failed: unknown;
    try {
      // Normally already locked by the worktree hook; this covers a worktree
      // Sandcastle reused.
      lockWorktree(sandbox.worktreePath);
      // A branch kept from an earlier run (red, conflicted, crashed) forks from
      // an older base. Asked to "merge it in", an agent that found the work
      // already done said so and stopped, and the branch hit the same conflict
      // at landing run after run. So the merge is made here: a clean one needs
      // no agent, and a conflicted one stays in progress for the implementer
      // to resolve - the prompt names the files, and the gates fail until it does.
      // Inside the container, never on the host: setup has already run the
      // branch's own install scripts in there, and the shared .git (or the
      // worktree's gitdir pointer) could by now name an fsmonitor or merge
      // driver that a host git in the worktree would execute.
      const carried = Number(sh("git", ["rev-list", "--count", `${base}..${branch}`])) > 0;
      // The requeue-once state holds the first attempt's line only on a second attempt in this run.
      const requeued = requeuedAs.has(issue.id);
      const behind = Number(sh("git", ["rev-list", "--count", `${branch}..${base}`]));
      // Read before the base merge, which moves the tip. A branch still at the
      // head it was reviewed and gated green on needs no implement or review:
      // only the merge and the gates stand between it and landing.
      const greenHead = carried ? landOnlyHead(project.root, base, issue.id) : undefined;
      let landOnly = greenHead !== undefined;
      if (greenHead !== undefined) {
        console.log(greenCarriedLine(ref(issue.id), greenHead, requeued));
        run.ticket(issue.id, { note: "land only - reviewed earlier" });
      }
      let mergeConflicted = false;
      // The base commit the merge below joined, for checking the resolution against git's own
      // merge. Read from the merge itself: the landing worker can move the base between a host
      // rev-parse and the merge, and the newly landed lines would then read as strays.
      let baseTip: string | undefined;
      if (behind > 0 && carried) {
        const identity = hostIdentity(project.root);
        const merge = `git ${identity} merge --no-edit ${shq(base)}`;
        const pull = await sandbox.exec(merge);
        const unmerged = pull.exitCode === 0 ? "" : (await sandbox.exec("git diff --name-only --diff-filter=U")).stdout.trim();
        const files = unmerged.split("\n").filter(Boolean);
        if (unmerged && regensFor(files, project.generated)) {
          // A conflict confined to declared generated files needs no agent: regenerate them.
          const r = await resolveGenerated(sandbox, {
            files,
            generated: project.generated,
            setup: project.setup,
            message: `Merge ${base} into ${branch} (generated files regenerated)`,
            identity,
          });
          if (r.ok) {
            console.log(carriedMergeLine(ref(issue.id), base, behind, requeued, { files, regen: r.regen }));
          } else {
            // Back to the merge as it stood, for the implementer (or, on a green
            // branch, the resolver) to resolve.
            await sandbox.exec("git merge --abort");
            await sandbox.exec(merge);
            mergeConflicted = true;
            console.log(
              `${ref(issue.id)}: ${carriedBranch(landOnly, requeued)} conflicts with ${base} in generated files (${files.join(", ")}), and regenerating failed (${r.reason}); ${landOnly ? "a resolver resolves the merge, then the gates run" : "the implementer resolves the merge"}.`,
            );
          }
        } else if (pull.exitCode === 0) console.log(carriedMergeLine(ref(issue.id), base, behind, requeued));
        else if (unmerged) {
          mergeConflicted = true;
          console.log(
            landOnly
              ? `${ref(issue.id)}: its green branch conflicts with ${base} (${files.join(", ")}); a resolver resolves the merge, then the gates run.`
              : `${ref(issue.id)}: ${carriedBranch(false, requeued)} conflicts with ${base} (${unmerged.split("\n").join(", ")}); the implementer resolves the merge.`,
          );
        }
        else {
          // Refused outright (untracked files it would overwrite, say): no
          // merge in progress, so nothing for the prompt to name.
          await sandbox.exec("git merge --abort");
          console.log(`${ref(issue.id)}: could not merge ${base} into its branch (${(pull.stderr || pull.stdout).trim().split("\n").at(-1)?.slice(0, 160)}); it may conflict at landing.`);
        }
      }
      if (mergeConflicted) {
        const head = await sandbox.exec("git rev-parse -q --verify MERGE_HEAD");
        if (head.exitCode === 0) {
          // Read inside the sandbox, after the branch's own setup ran there: trusted only when the
          // host finds it on the base's history. Otherwise the resolution has nothing sound to be
          // checked against, so the full implement and review take the branch.
          const tip = head.stdout.trim();
          try {
            sh("git", ["merge-base", "--is-ancestor", tip, `refs/heads/${base}`]);
            baseTip = tip;
          } catch {
            console.log(`${ref(issue.id)}: the merge in its sandbox names ${tip.slice(0, 12)}, which is not on ${base} - the full implement and review run.`);
            landOnly = false;
          }
        }
      }
      // A conflicted merge on a branch that is already reviewed and green needs
      // only the merge resolved, not the issue implemented again: a short prompt
      // on the same sandbox. A resolver that leaves the merge in progress could
      // not resolve it without changing what the ticket does, so the full
      // implementer takes the branch, as it does for any carried branch.
      if (landOnly && mergeConflicted) {
        await timed(issue.id, "implement", () => {
          const logging = agentLogging(project, issue.id, `impl-${issue.id}`, runId);
          return sandbox.run({
            name: `impl-${issue.id}`,
            logging,
            agent: implAgent(own),
            promptFile: prompts.resolve,
            promptArgs: usedArgs(prompts.resolve, promptArgs),
            maxIterations: project.repair.maxIterations ?? 4,
            idleTimeoutSeconds: project.repair.idleTimeoutSeconds ?? 2400,
          });
        },
          "resolving the base merge",
          () => implModel,
        ).catch((error) => {
          if (hitLimit(issue.id)) throw error;
          console.log(`${ref(issue.id)}: the resolver failed (${String(error).slice(0, 120)}).`);
        });
        if ((await sandbox.exec("git rev-parse -q --verify MERGE_HEAD")).exitCode === 0) {
          console.log(`${ref(issue.id)}: the merge is still unresolved - the full implement and review run.`);
          landOnly = false;
        }
      }
      if (landOnly && mergeConflicted && greenHead !== undefined && baseTip !== undefined) {
        // A resolution may touch only what git could not merge itself: a change to any other
        // path can drop another ticket's landed lines with every gate green.
        const stray = strayChanges(project.root, { ours: greenHead, theirs: baseTip, resolved: sh("git", ["rev-parse", branch]), generated: project.generated });
        if (stray?.length) {
          const why = strayNote(stray);
          console.log(`${ref(issue.id)}: the ${why} - held for a human.`);
          run.ticket(issue.id, { files: stray });
          notes.push({ issue: issue.id, kind: "hold", text: `Sandcastle held this: ${why}.`, held: why });
          // `held` from the first write: the kit held a finished, green resolution, the agent handed nothing back.
          return { issue: issue.id, branch, status: "held", heldNote: why, commits: 0, reviewCommits: 0, repairs: 0, gates: [] };
        }
      }
      // Review passes run on the same warm sandbox and branch. Their commits
      // ride the same gates as the implementer's, so a review that breaks the
      // build cannot merge either. Log names keep `-review-` for status.sh.
      const reviewRun = (name: string, promptFile = prompts.review, args: Record<string, string> = promptArgs) => (agent: Parameters<typeof sandbox.run>[0]["agent"]) =>
        sandbox.run({
          name,
          logging: agentLogging(project, issue.id, name, runId),
          agent,
          promptFile,
          promptArgs: usedArgs(promptFile, args),
          maxIterations: project.review.maxIterations ?? 3,
          idleTimeoutSeconds: project.review.idleTimeoutSeconds ?? 2400,
        });
      // The narrow review, as after a repair: only what is new since `since`, which
      // is a base merge and its conflict resolution. No cross-review. A review that
      // throws behaves as the full one does.
      const narrowReview = (since: string, note: string) => {
        let narrowModel: string | undefined;
        return timed(
          issue.id,
          "review",
          () => {
            return reviewWithFallback(ref(issue.id), (agent, model) => {
              narrowModel = model;
              return reviewRun(`review-${issue.id}`, prompts.remerge, { ...promptArgs, REVIEW_BASE: since })(agent);
            });
          },
          note,
          () => narrowModel,
        );
      };
      let reviewCommits = 0;
      // What reviewers said no gate exercises; read whether or not the tracker lets agents write.
      const ungated: string[] = [];
      if (landOnly && mergeConflicted && greenHead !== undefined) {
        // The resolver finished the merge on a branch reviewed and green at greenHead:
        // nobody has seen its resolution. A clean land-only merge needs no review.
        console.log(`${ref(issue.id)}: conflict resolved - reviewing the resolution only.`);
        const resolved = await narrowReview(greenHead, "after conflict resolution");
        noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch]) });
        reviewCommits = resolved.commits.length;
        const said = tracker.agentsWrite ? undefined : tags(resolved.stdout).report;
        if (said) addReport(issue.id, "Reviewer (after conflict resolution)", said);
      }
      if (!landOnly) {
        const impl = await timed(issue.id, "implement", () => {
          const logging = agentLogging(project, issue.id, `impl-${issue.id}`, runId);
          return sandbox.run({
            name: `impl-${issue.id}`,
            logging,
            agent: implAgent(own),
            promptFile: prompts.implement,
            promptArgs: usedArgs(prompts.implement, promptArgs),
            maxIterations: project.implement.maxIterations ?? 8,
            idleTimeoutSeconds: project.implement.idleTimeoutSeconds ?? 2400,
          });
        },
          undefined,
          () => implModel,
        );

        if (!tracker.agentsWrite) {
          const { blocked, report } = tags(impl.stdout);
          if (blocked) {
            notes.push({ issue: issue.id, kind: "hold", text: `Sandcastle could not finish this.\n\n${blocked}` });
            return { issue: issue.id, branch, status: "nochange", commits: 0, reviewCommits: 0, repairs: 0, gates: [] };
          }
          if (report) addReport(issue.id, "Implementer", report);
        }

        // `impl.commits` counts what THIS run added, which is zero in two very
        // different cases: the agent found nothing to do, and the agent found the
        // work already done on the branch from an earlier run. Only the first is
        // `nochange`. How far the branch is ahead of the base tells them apart -
        // without it, a branch whose review died could never be reviewed by
        // re-running the issue: it came straight back as `nochange` with the work
        // still standing, unreviewed and unmerged.
        const branchCommits = Number(sh("git", ["rev-list", "--count", `${base}..${branch}`]));
        if (impl.commits.length === 0 && branchCommits === 0) {
          // Nothing lands for a nochange, so nothing else would carry the report.
          return { issue: issue.id, branch, status: "nochange", commits: 0, reviewCommits: 0, repairs: 0, gates: [] };
        }

        // Only a base merge since the last completed review: review the merge, not the branch.
        const since = narrowReviewBase(project.root, base, issue.id);
        if (since !== undefined && since === sh("git", ["rev-parse", branch])) {
          console.log(`${ref(issue.id)}: nothing new since its review at ${since.slice(0, 7)} - no review; the gates decide.`);
        } else if (since !== undefined) {
          console.log(`${ref(issue.id)}: only a base merge since its review at ${since.slice(0, 7)} - reviewing the merge only.`);
          const merged = await narrowReview(since, "after base merge");
          noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch]) });
          reviewCommits = merged.commits.length;
          const said = tracker.agentsWrite ? undefined : tags(merged.stdout).report;
          if (said) addReport(issue.id, "Reviewer (after base merge)", said);
        } else {
          let reviewModel: string | undefined;
          const review = await timed(
            issue.id,
            "review",
            () => {
              return reviewWithFallback(ref(issue.id), (agent, model) => {
                reviewModel = model;
                return reviewRun(`review-${issue.id}`)(agent);
              });
            },
            undefined,
            () => reviewModel,
          );
          const cross = CROSS_REVIEW
            ? await timed(
                issue.id,
                "cross-review",
                () => {
                  return crossReview(ref(issue.id), reviewRun(`review-codex-${issue.id}`));
                },
                undefined,
                () => CROSS_REVIEW_MODEL,
              )
            : undefined;
          noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch]) });
          reviewCommits = review.commits.length + (cross?.commits.length ?? 0);
          for (const r of [review, cross]) {
            const u = r && ungatedOf(r.stdout);
            if (u) ungated.push(u);
          }
          if (!tracker.agentsWrite) {
            for (const [who, r] of [["Reviewer", review], ["Cross-reviewer", cross]] as const) {
              const said = r && tags(r.stdout).report;
              if (said) addReport(issue.id, who, said);
            }
          }
        }
      }

      // Gates are checked here, in the orchestrator. No agent gets to tell us
      // they passed - `exitCode` is returned rather than thrown.
      let gated = await timed(issue.id, "gates", () => runGates(sandbox, issue.id));
      // The forced red is named as such everywhere it shows: "ruff red" for a
      // gate that passed sent a reader looking for a ruff failure.
      let forced = false;
      if (TEST_RED_GATE && !gated.failure) {
        forced = true;
        const g = project.gates[0];
        const failure = {
          name: g.name,
          command: g.command,
          exitCode: 1,
          output:
            "SANDCASTLE_TEST_RED_GATE=1: the orchestrator counted this gate run as red to test the repair pass. " +
            "The gate itself passed. Run the gates to confirm; if they are green there is nothing to fix, so commit nothing.",
        };
        gated = { gates: [{ name: g.name, pass: false }], failure, failures: [failure] };
      }

      // A red gate is often one type error or one broken test away from green,
      // and the sandbox is still warm. Repair commits ride the same gates and
      // the same protected-path check, and a green repaired branch is reviewed
      // again (below). Not after a timeout (124): a hung gate leaves nothing
      // to repair from and would hang again.
      //
      // `attempts` passes, plus up to two more while each one turns up a
      // failure no earlier pass saw: a gate that stops at its first failure
      // (`pytest -x`) showed a repair one test, hid a second, and a branch one
      // line from green stayed unmerged. The same failure twice stops it.
      const attempts = project.repair.attempts ?? 1;
      const preRepair = sh("git", ["rev-parse", branch]);
      const seen = new Set<string>();
      let repairs = 0;
      for (
        let red = gated.failure;
        red && red.exitCode !== 124 && attempts > 0 && repairs < attempts + 2 && (repairs < attempts || !seen.has(failureKey(red)));
        red = gated.failure
      ) {
        const failure = red;
        seen.add(failureKey(failure));
        repairs++;
        const why = forced ? "test red gate" : `${failure.name} red`;
        console.log(
          `${ref(issue.id)}: ${forced ? `test red gate (SANDCASTLE_TEST_RED_GATE; ${failure.name} passed)` : why} - repair pass ${repairs}`,
        );
        forced = false;
        // A repair that dies (idle timeout, agent exit) leaves the branch red,
        // not the issue crashed: the gate results stay in the report. A spent
        // allowance still has to stop the queue, so that one is rethrown.
        const fixed = await timed(issue.id, "repair", () => {
          const logging = agentLogging(project, issue.id, `repair-${issue.id}`, runId);
          return sandbox.run({
            name: `repair-${issue.id}`,
            logging,
            agent: implAgent(own),
            promptFile: prompts.repair,
            promptArgs: usedArgs(prompts.repair, {
              ...promptArgs,
              GATE_NAME: failure.name,
              GATE_COMMAND: failure.command,
              GATE_OUTPUT: fence(failure.output),
            }),
            maxIterations: project.repair.maxIterations ?? 4,
            idleTimeoutSeconds: project.repair.idleTimeoutSeconds ?? 2400,
          });
        },
          `${why} - pass ${repairs}`,
          () => implModel,
        ).then(
          (fixedRun) => {
            const said = tracker.agentsWrite ? undefined : tags(fixedRun.stdout).report;
            if (said) addReport(issue.id, "Repair", said);
            return true;
          },
          (error) => {
            if (hitLimit(issue.id)) throw error;
            console.log(`${ref(issue.id)}: repair pass failed (${String(error).slice(0, 120)}); leaving the branch red.`);
            return false;
          },
        );
        if (!fixed) break;
        gated = await timed(issue.id, "gates", () => runGates(sandbox, issue.id));
      }

      // A repair works against a red gate, and the easy way to green is to
      // weaken the test - which the gate then passes. The prompt forbids it,
      // but a rule is not a check: a green branch whose repair committed gets
      // the review pass again, on the repair commits. Its own commits are
      // gated once more; a red there is final, with no second repair loop.
      let unreviewed = false;
      if (!gated.failure && sh("git", ["rev-parse", branch]) !== preRepair) {
        // A review that dies leaves the branch held, not the ticket crashed:
        // like a failed repair, only a spent allowance stops the queue.
        let afterModel: string | undefined;
        const after = await timed(
          issue.id,
          "review",
          () => {
            return reviewWithFallback(ref(issue.id), (agent, model) => {
              afterModel = model;
              return reviewRun(`review-${issue.id}`, prompts.rereview, { ...promptArgs, REPAIR_BASE: preRepair })(agent);
            });
          },
          "after repair",
          () => afterModel,
        ).catch((error) => {
          if (hitLimit(issue.id)) throw error;
          console.log(`${ref(issue.id)}: the review after repair failed (${String(error).slice(0, 120)}); holding the branch for a human.`);
          unreviewed = true;
          return undefined;
        });
        if (after) {
          noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch]) });
          reviewCommits += after.commits.length;
          const u = ungatedOf(after.stdout);
          if (u) ungated.push(u);
          const said = tracker.agentsWrite ? undefined : tags(after.stdout).report;
          if (said) addReport(issue.id, "Reviewer (after repair)", said);
          if (after.commits.length) gated = await timed(issue.id, "gates", () => runGates(sandbox, issue.id));
        }
      }

      const head = sh("git", ["rev-parse", branch]);
      if (!gated.failure && !unreviewed) noteHead(issue.id, branch, { green: head });
      return {
        issue: issue.id,
        branch,
        status: gated.failure ? "gate-failed" : "green",
        // Branch total, so a re-run of an already-implemented branch does not
        // report 0 commits while shipping its work. Without the kit's base merge-ins.
        commits: ownCommits(base, branch),
        reviewCommits,
        repairs,
        gates: gated.gates,
        failing: gated.failure ? failingTests(gated.failure.output) : undefined,
        head,
        carried,
        unreviewed,
        ungated: ungated.length ? cutAtWord([...new Set(ungated)].join("; "), UNGATED_MAX) : undefined,
      };
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      // Added up: a requeued ticket's second pipeline is more time on it, not a replacement.
      took.set(issue.id, (took.get(issue.id) ?? 0) + Date.now() - started);
      unlockWorktree(sandbox.worktreePath);
      // Sandcastle keeps a worktree with uncommitted files rather than lose
      // them. Say so, or it lingers unexplained in .sandcastle/worktrees/.
      const closed = await sandbox.close();
      if (closed.preservedWorktreePath) keptWorktrees.push({ issue: issue.id, path: closed.preservedWorktreePath });
      try {
        await host.settle(branch, `after ${ref(issue.id)}`);
      } catch (error) {
        tampered.set(issue.id, error);
        // A pipeline that crashed on its own keeps its own error; the run
        // stops either way.
        if (failed === undefined) throw error;
      }
    }
  };

  // A spent plan allowance fails every issue after it the same way, each one
  // after paying for a sandbox and an install. The first one stops the queue.
  const hitLimit = (issue: string) => {
    const logs = join(project.root, ".sandcastle/logs");
    if (!existsSync(logs)) return false;
    return readdirSync(logs)
      // Not the .jsonl sidecar: its last lines are raw tool results, and a file the agent merely read could say "usage limit".
      .filter((f) => f.endsWith(".log") && logOwner(f) === issue)
      .some((f) => LIMIT.test(readFileSync(join(logs, f), "utf8").split("\n").slice(-8).join("\n")));
  };

  const gateNames = project.gates.map((g) => g.name).join(", ");
  // The ticket's state as landing decides it, for the notes below.
  const land = (id: string, state: TicketState, note: string) => run.ticket(id, { state, note });

  const slotWanted = { n: 0 };
  const ctx: LandContext = {
    project,
    tracker,
    base,
    gateNames,
    reports,
    run,
    dryRun: DRY_RUN,
    opener: sandboxOpener(project, image, planFile),
    withdrawal,
    host,
    gate: (box, id) => runGates(box, id),
    landed: new Map(),
    slotWanted,
  };

  const results: PromiseSettledResult<Outcome>[] = [];
  const crashed = new Map<string, string>();
  const uncommittedWork = (o: Outcome) => keptFor(o, keptWorktrees);
  // A requeued ticket's second pipeline replaces its first in the per-issue lines.
  const dropFirstResult = (id: string) => {
    const earlier = results.findIndex((r) => r.status === "fulfilled" && r.value.issue === id);
    if (earlier >= 0) results.splice(earlier, 1);
  };
  // The ticket's state once its pipeline ends. A green branch that changes
  // hooks, CI or install scripts says so now: before, a human merge was news
  // only at the end of the run.
  const settled = (o: Outcome): TicketRecord => {
    const repaired = o.repairs ? `, ${o.repairs} repair(s)` : "";
    if (o.status === "green") {
      const held = [...protectedChanges(project, o.branch), ...largeFiles(project, o.branch)];
      if (o.unreviewed) held.push("repair not reviewed");
      return { state: "ready", note: held.length ? `human merge: ${held.join(", ")}` : `gates green${repaired}` };
    }
    if (o.status === "merged-earlier") return { state: "ready", note: `merged earlier (${o.head}) - to close` };
    if (o.status === "gate-failed") return { state: "red", note: `${o.gates.filter((g) => !g.pass).map((g) => g.name).join(", ")} red${repaired}` };
    const handedBack = notes.some((n) => n.issue === o.issue && n.kind === "hold");
    return o.status === "held" ? settledUnlanded(o, handedBack) : noCommitRecord(o, keptWorktrees, project.root, handedBack);
  };
  // What the view and the records say about a finished pipeline. A throw here
  // (a git call, a full disk) would escape to the scheduler and cost the ticket
  // its ending: every green branch left unlanded for want of a status line.
  const bookkeep = (id: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      console.log(`${ref(id)}: could not record its state (${String(error).split("\n")[0].slice(0, 160)}); its outcome stands.`);
    }
  };
  // The record's side of a requeue: the line the second attempt's setup carries (`requeuedAs`), and
  // what a second conflict or red was held as, for the outcome the status view reads (`againNote`).
  const requeues = createRequeueRecord({ run, bookkeep, dropFirst: dropFirstResult, ref, say: (line) => console.log(line) });
  const { requeuedAs, againNote } = requeues;

  // One attempt of a ticket (schedule.ts runs it): the usage check and the tracker's word before
  // it, then its pipeline in a sandbox slot. A landing that waits for a slot goes first (`slotTurn`).
  const attempt = async (issue: Issue, { last }: { last(): boolean }): Promise<Attempted<Outcome, Outcome>> => {
    const line = await usageStop(env);
    if (line) return { kind: "not begun", why: { kind: "usage limit", line } };
    // A tracker that cannot be read is no reason to skip: the check before landing asks again.
    const called = (() => {
      try {
        return withdrawal(issue.id);
      } catch {
        return undefined;
      }
    })();
    if (called) return { kind: "not begun", why: { kind: "withdrawn", reason: called.reason } };
    const result = await slotTurn(slotWanted)
      .then(() => withSlot("sandboxes", `${project.name} ${ref(issue.id)}`, () => pipeline(issue)))
      .then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const,
      );
    // A requeued ticket's second pipeline replaces its first in the per-issue lines.
    dropFirstResult(issue.id);
    results.push(result);
    if (result.status === "fulfilled") {
      const value = result.value;
      bookkeep(issue.id, () => {
        const tokens = spent.get(issue.id);
        run.ticket(issue.id, {
          ...settled(value),
          commits: value.commits,
          minutes: Math.round((took.get(issue.id) ?? 0) / 60_000),
          ...(tokens ? { tokens: tokenBrief(tokens) } : {}),
          ...(value.failing?.length ? { failing: value.failing } : {}),
          ...(value.ungated ? { ungated: value.ungated } : {}),
        });
        run.update({ typical: typicalTimes(project, [...took.values()]) });
        // With nothing left to start, the pane closes: five panes each
        // frozen on a finished agent's summary read as five stuck sandboxes.
        // A stopped run starts nothing, whatever is still queued or parked.
        view.finish(issue.id, uncommittedWork(value) ? "uncommitted" : finishWord(value), last());
        // Recorded now, not only at the report: a branch waiting for
        // landing had no outcome for this run, and its row read as an
        // earlier run's leftover. Landing overwrites it.
        recordOutcomes(project, runId, { [issue.id]: uncommittedWork(value) ? "uncommitted" : outcomeText(value) });
      });
      // To the landing worker as it ends, not when the slowest pipeline does.
      return value.status === "green" || value.status === "merged-earlier" ? { kind: "green", green: value } : { kind: "pipeline", outcome: value };
    }
    const reason = result.reason;
    const checked = tampered.has(issue.id);
    const tamper = tampered.get(issue.id);
    tampered.delete(issue.id);
    // The .git check after this ticket's pipeline failed: its work
    // finished, and the whole run stops. Not a crash of the ticket.
    if (checked && tamper === reason) {
      bookkeep(issue.id, () => {
        run.ticket(issue.id, STOPPED_GREEN.record);
        recordOutcomes(project, runId, { [issue.id]: STOPPED_GREEN.outcome });
        // The run starts nothing more, so nothing will reuse the pane.
        view.finish(issue.id, "stopped", true);
      });
      return { kind: "stopped", cause: { kind: "tampered", error: reason } };
    }
    crashed.set(issue.id, String(reason));
    let limited = false;
    bookkeep(issue.id, () => {
      run.ticket(issue.id, { state: "crashed", note: String(reason).split("\n")[0].slice(0, 160) });
      // Kept open even at the end of the queue: a crash is for a human to read.
      view.finish(issue.id, "crashed");
      limited = hitLimit(issue.id);
    });
    // A pipeline that crashed on its own keeps its own error; a failed check after it stops the run all the same.
    const causes: StopCause[] = [...(checked ? [{ kind: "tampered" as const, error: tamper }] : []), ...(limited ? [{ kind: "plan limit" as const, ticket: issue.id }] : [])];
    return { kind: "crashed", error: reason, causes };
  };

  // How each ticket's part in the run ended, as the scheduler tells it, written to the record.
  const ended = (id: string, e: Ending<Outcome, Outcome>) => {
    if (e.kind === "landing") {
      requeues.ended(id, e);
    } else if (e.kind === "not begun" && e.why.kind === "withdrawn") {
      const { reason } = e.why;
      bookkeep(id, () => run.ticket(id, withdrawnRecord(reason)));
    } else if (e.kind === "not begun" && e.why.kind === "refused label") {
      // Its label refuses it, found as it would have started: that ticket only, never the run.
      const { reason } = e.why;
      console.log(`  ${reason}`);
      bookkeep(id, () => run.ticket(id, refusedRecord(reason)));
    } else if (e.kind === "stopped" && e.green) {
      bookkeep(id, () => {
        run.ticket(id, STOPPED_GREEN.record);
        recordOutcomes(project, runId, { [id]: STOPPED_GREEN.outcome });
      });
    } else if (e.kind === "crashed" && e.green) {
      // The land port threw rather than say how the landing went: this ticket only.
      crashed.set(id, String(e.error));
      bookkeep(id, () => run.ticket(id, { state: "crashed", note: errorLine(e.error) }));
    }
  };
  const tell = (c: Change<Outcome, Outcome, Blocker>) => {
    switch (c.kind) {
      case "landing":
        // Only the run line: the next landing writes it again.
        run.update({ stage: `landing ${c.at}/${c.of}` });
        return;
      case "requeued":
        // Written before the ticket is queued again, with the line its second pipeline's setup carries.
        return requeues.requeued(c.id, c.again);
      case "ended":
        return ended(c.id, c.ending);
      case "blocked":
        return bookkeep(c.id, () => run.ticket(c.id, { note: blockedNote(c.on, new Set(c.inFlight), new Set(c.landed)) }));
      case "unreleased":
        console.log(`${ref(c.id)}: could not start the tickets that wait for it (${errorLine(c.error)}); they wait for the next run.`);
        return;
      default:
        return holds.tell(run, c);
    }
  };

  // The run stops: the summary still prints, headed by why - a stack trace was all a
  // stopped run left, and its report then said "Run finished".
  const stopLanding = async (error: unknown): Promise<never> => {
    const why = String((error as Error).message ?? error);
    run.update({ stopped: why });
    console.log(`\n${await closingReport(project)}\n`);
    throw error;
  };

  const { endings, stop } = await schedule
    .run({ workers, attempt, ...landingWork(ctx), tell })
    .catch((error: unknown) => {
      clearInterval(heartbeat);
      return stopLanding(error);
    });
  clearInterval(heartbeat);
  // A pipeline that fails its own `.git` check after the base moved finished its work: it is
  // stopped, not crashed. Each one's error is kept as a cause, so none reads as a crash.
  const stoppedBy = (reason: unknown) => stop.causes.some((c) => c.kind === "tampered" && String(c.error) === String(reason));
  // The cause the closing summary names: the most severe, a `.git` change before a limit.
  const headline = stop.headline;
  const stopLine = headline && stopWords(headline);
  // The tickets the pipelines took in, and the ones of them no attempt began for.
  const entered = [...endings.values()].filter((e) => e.kind !== "waiting" && !(e.kind === "not begun" && e.why.kind === "refused label"));
  const notStarted = entered.filter((e) => e.kind === "not begun").length;
  for (const [id, e] of endings) {
    if (e.kind === "not begun" && e.why.kind !== "withdrawn" && e.why.kind !== "refused label") run.ticket(id, { state: "skipped", note: `not started: ${stopLine ?? "the run stopped"}` });
  }
  // What landing decided, for the closing report: each landing ending, in the order they came.
  const landings = newLandings();
  for (const e of endings.values()) if (e.kind === "landing") accountLanding(landings, e.green, e.landed);
  const { merged, regenerated, conflicted, redMerged, heldBack, failedToLand, skipped, withdrawn, takenBack, closedEarlier, closeFailed } = landings;

  // A safety stop (a `.git` change, after a pipeline or under the landing worker, or a refused
  // write) landed nothing more: the run stops, headed by the most severe of them.
  if (stop.landsNothing && headline) await stopLanding(stopError(headline));

  // An agent that can write to the tracker (GitHub) hands a ticket back
  // itself - hold label on, queue label off - and commits nothing, so its
  // pipeline ends as nochange. Reported as "nothing to change", a question
  // for a human read as a ticket that needed no work.
  const handedBack: string[] = [];
  if (tracker.agentsWrite && !DRY_RUN) {
    for (const r of results) {
      if (r.status !== "fulfilled" || r.value.status !== "nochange" || uncommittedWork(r.value)) continue;
      try {
        if (tracker.get(r.value.issue).held) handedBack.push(r.value.issue);
      } catch {
        /* unreadable: it stays "no change" */
      }
    }
    for (const id of handedBack) land(id, "held", "handed back - for a human");
  }

  // Whatever the agents said about a ticket that did not land (red gate,
  // conflict, nothing to change) would otherwise live only in an archived log.
  for (const id of new Set([...reports.keys(), ...conflicted.map((c) => c.issue), ...redMerged.map((r) => r.issue)])) {
    if (merged.includes(id) || closedEarlier.includes(id) || heldBack.some((h) => h.issue === id) || notes.some((n) => n.issue === id)) continue;
    const c = conflicted.find((x) => x.issue === id);
    const r = redMerged.find((x) => x.issue === id);
    const text = notLandedComment(reports.get(id), c && { branch: c.branch, base, files: c.files, with: c.with }, r && { branch: r.branch, base, with: r.with, gates: r.gates });
    if (text !== undefined) notes.push({ issue: id, kind: "comment", text });
  }
  // Through the landing worker's writer: a ticket-file tracker commits each one on the base branch.
  for (const n of notes) {
    if (DRY_RUN) console.log(`[dry run] would ${n.kind === "hold" ? "hold for a human" : "comment on"} ${ref(n.issue)}: ${n.text.slice(0, 120)}`);
    else {
      try {
        await host.write(() => (n.kind === "hold" ? tracker.hold(n.issue, n.text) : tracker.comment(n.issue, n.text)), trackerMade(project.root));
      } catch (error) {
        console.log(`Could not update ${ref(n.issue)}: ${errorLine(error)}`);
      }
    }
    // A hold on a ticket whose finished work sits uncommitted keeps its own state: the work exists.
    if (n.kind === "hold" && !keptFor({ issue: n.issue, status: "nochange", commits: 0 }, keptWorktrees)) {
      view.landed(n.issue, false, "needs a human");
      land(n.issue, "held", n.held ?? "handed back - for a human");
    }
  }
  // A note refused by the writer's `.git` check: the verify would start a container and run git on the host.
  if (stop.landsNothing) await stopLanding(stopError(stop.headline!));
  for (const n of merged) view.landed(n, true, closeFailed.includes(n) ? "merged, not closed" : "merged");
  for (const n of closedEarlier) view.landed(n, true, "closed");
  for (const c of conflicted) view.landed(c.issue, false, "merge conflict");
  for (const r of redMerged) view.landed(r.issue, false, "red when merged");
  for (const f of failedToLand) view.landed(f.issue, false, "failed to land");
  for (const k of skipped) view.landed(k.issue, false, "not merged");
  for (const w of withdrawn) view.landed(w.issue, true, "withdrawn");
  for (const h of heldBack) view.landed(h.issue, false, "needs a human");
  for (const id of [...handedBack, ...takenBack]) view.landed(id, false, "needs a human");

  // -------------------------------------------------------------------------
  // Phase 4: the gates on the merged base branch. Each branch was gated on its
  // own; together they can still be red.
  // -------------------------------------------------------------------------

  let verify: Gate[] | undefined;
  if (merged.length > 1 || regenerated.size > 0) {
    const gated = await timed("", "verify", () => gateBase(project, image, planFile, "verify"));
    verify = gated.gates;
    // A red merged base said "do not push" with nothing to read: its output goes where the base gates' does.
    const at = sh("git", ["rev-parse", "--short", base], project.root);
    if (writeGateLog(join(project.root, VERIFY_LOG), `# gates on the merged ${base} at ${at}, ${new Date().toISOString()}: ${gateLine(verify)}`, gated.failures)) {
      for (const f of gated.failures) console.log(`\n--- verify ${f.name} (exit ${f.exitCode}), last lines:\n${f.output.split("\n").slice(-15).join("\n")}`);
      console.log(`Full output: ${VERIFY_LOG}`);
    }
  }
  run.update({ stage: "report" });

  // Each branch's outcome, for the status view's rows (run.ts).
  const outcome = new Map<string, string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    outcome.set(r.value.issue, uncommittedWork(r.value) ? "uncommitted" : outcomeText(r.value));
  }
  for (const [id, line] of landingLines(landings, againNote)) outcome.set(id, line);
  for (const id of handedBack) outcome.set(id, "needs a human: handed back");
  if (DRY_RUN) for (const r of results) if (r.status === "fulfilled" && r.value.status === "green") outcome.set(r.value.issue, "dry run: gated green, would merge");
  for (const [n] of crashed) outcome.set(n, "crashed");
  recordOutcomes(project, runId, Object.fromEntries(outcome));

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  // The detail, one line per issue, for an engineer. The closing summary
  // after it says what to do next (report.ts). The word is each ticket's final
  // state: "shipped" once sat on every branch, held ones included.
  console.log("\n--- per ticket ---");
  const final = run.tickets();
  for (const r of results) {
    if (r.status === "rejected") {
      console.log(`  ${stoppedBy(r.reason) ? "STOPPED" : "CRASHED"}  ${String(r.reason).split("\n")[0].slice(0, 200)}`);
      continue;
    }
    const o = r.value;
    const state = final[o.issue]?.state === "red" ? "gate red" : (final[o.issue]?.state ?? o.status);
    const repaired = o.repairs ? ` repaired=${o.repairs}` : "";
    const time = took.has(o.issue) ? ` ${minutes(took.get(o.issue)!)}` : "";
    const cost = spent.has(o.issue) ? `  tokens ${tokenLine(spent.get(o.issue)!)}` : "";
    console.log(`  ${ref(o.issue)} ${state.padEnd(10)} commits=${o.commits} (review=${o.reviewCommits})${repaired} ${gateLine(o.gates)}${time}  ${o.branch}${cost}`);
  }
  const total = [...spent.values()].reduce(addTokens, NO_TOKENS);
  if (spent.size) console.log(`  all agents: tokens ${tokenLine(total)} (per phase in .sandcastle/logs/timings.jsonl)`);
  console.log("  logs: .sandcastle/logs/agent-issue-<id>-*.log (a merged branch's logs move to logs/archive/ at the next run or `sandcastle clean`)");
  if (stopLine) console.log(`\nSTOPPED EARLY: ${stopLine}; ${notStarted} queued ticket(s) were not started.`);
  let dryRunCheck: string | undefined;
  if (before) {
    const after = tracker.snapshot([...before.keys()].filter((k) => k !== LATEST_ISSUE));
    const changed = [...before].filter(([n, was]) => after.get(n) !== was);
    dryRunCheck = changed.length
      ? `DRY RUN BREACHED: ${changed.map(([n, was]) => `${ref(n)} ${was} -> ${after.get(n)}`).join("; ")} - an agent wrote to the tracker.`
      : `dry run held: ${[...before.keys()].filter((k) => k !== LATEST_ISSUE).length} ticket(s) unchanged in the tracker.`;
  }
  run.update({ verify: verify ? { green: verify.every((g) => g.pass), line: gateLine(verify) } : null, keptWorktrees, dryRunCheck });
  console.log(`\n${await closingReport(project, turn)}\n`);
  view.close(
    `merged ${merged.length}` +
      (conflicted.length + redMerged.length + failedToLand.length + skipped.length ? `, not landed ${conflicted.length + redMerged.length + failedToLand.length + skipped.length}` : "") +
      (heldBack.length + handedBack.length + takenBack.length ? `, needs a human ${heldBack.length + handedBack.length + takenBack.length}` : "") +
      (withdrawn.length ? `, withdrawn ${withdrawn.length}` : "") +
      ` of ${entered.length}`,
  );
  return true;
};
