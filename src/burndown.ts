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

import { createSandbox, type Sandbox } from "@ai-hero/sandcastle";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, REVIEW_MODEL, crossReview, implAgent, implementNote, type Override, reviewWithFallback, ticketOverride } from "./agents.ts";
import { red, runApiKeyLine } from "./api-key.ts";
import type { Project } from "./config.ts";
import { BaseRedError, changedDockerfiles, FAILING_TESTS_SHOWN, type Gate, type GateRun, failingTestFile, failingTests, failureKey, gateBase, gateLine, gateMs, gateRed, requireGreenBase, stepTimes, timedLandingGate, withQueued, writeLandingLine, runGates as gatesIn, noteGreenCommit, greenProofOfBase, verifyBase, VERIFY_LOG, writeGateLog } from "./gates.ts";
import { blockedNote, blockerProblems, blockerResolver, blockerTicket, commentBlockLine, commentOnlyBlocks, openBlockers, openBlockersNow, refLabel, type Blocker } from "./blockers.ts";
import { disableHostGitGc, disableHostGitHooks, gitFingerprint, guardWords, largeFiles, lockRun, pinHostGitConfig, protectedChanges, protectedPlanLines, pruneBackup } from "./guard.ts";
import { checkHooks, hiddenReferences, reportHookCheck, unmatched, unmatchedLines, writePlan } from "./lean.ts";
import { IN_HERDR, openSandboxView, type SandboxView, sandboxPanes } from "./herdr.ts";
import { registerRun } from "./live-runs.ts";
import { agentBaseline, peakOf, recordPeak, sampling } from "./peaks.ts";
import { isTicketState, type PlanUsage, type RunRecord, type TicketRecord, type TicketState } from "../mod/hooks/run-record.ts";
import { estimateSlots, joinPool, leaseSlot, limit, myShare, otherRuns, recordOfRun, setDemand, type SlotLease, splitAtStart, startLines, usage, type WaitReason, wholeNumber } from "./pool.ts";
import {
  addTokens, agentLogging, archiveFinishedLogs, assertCleanBase, baseIsTheRunsLine, gatesLog, holdAwake, keepAwake, landOnlyHead, logSaysLimit, markLog, narrowReviewBase, NO_TOKENS, openStatusPane, preflight, readHeads, recordHead, relabelContextWindow, releaseAwake, reviewedOnlyHead,
  namedTicketsFromEnv, recordRun, renderPrompts, runTokens, type Tokens, tokenBrief, estimate, isCarried, tokenLine, typicalTimes, firstSlotWait, usedArgs, logOwner, implChangelogView, liveTokenWriter,
} from "./run.ts";
import { mergeTree, mergeTreeSupported, strayChanges, strayNote } from "./resolution.ts";
import { resolveVersions, versionsLine } from "./versions.ts";
import { cpusLine, credentials, ensureImage, errorLine, machineSettings, ownCommits, projectApiKeySpend, reapOrphans, sandboxConfig, sandboxCpus, sh } from "./sandbox.ts";
import { readDockerInfo, turnDockerInfo } from "./runtime.ts";
import { poolWarningsNow } from "./size.ts";
import { LATEST_ISSUE, ensureTriageLabel, makeTracker, type Ticket, type Tracker } from "./tracker.ts";
import { closingReport, summary, verifySkippedLine } from "./report.ts";
import { notifyCommand, runNotify } from "./notify.ts";
import { type ResolvedSettings, resolveSettings, settingsGroup } from "./run-settings.ts";
import { createPauseHandling, createUsagePause, readCodexAuth, showsCodexUsage, showsPlanUsage, usageLine, usagePauseLine, usageReadingLost, usageStop, type UsageWatch, watchUsage } from "./usage.ts";
import { lockWorktree, releaseBranchWorktree, unlockAll, unlockWorktree } from "./worktree-lock.ts";
import { OperatorError } from "./errors.ts";
import { hostIdentity, regensFor, resolveGenerated, shq } from "./generated.ts";
import { sandboxOpener } from "./land.ts";
import {
  carriedBranch, carriedMergeLine, conflictLine, createHostGit, firstAttemptIdleRepairs, firstAttemptRepairs, firstAttemptReviewCommits, greenCarriedLine, type HostGit, didMerge, isAncestor, type LandContext, landingSlotNote, landingWork, pipelineWorkers, type RedLanding, repairFromRed, reviewedCarriedLine, slotTurn, trackerMade,
} from "./landing.ts";
import { accountLanding, causeWords, type Context, createLedger, outcomesFile, repairWords, stoppedLine } from "./ledger.ts";
import { type Attempted, type Change, type Conflict, createFixBoard, createSchedule, fileShareLine, fileShareSummary, fileWaitNote, type FileShare, type FixBoard, type HoldChange, type Park, type Start, StoppedWhileParked, type StopCause, stoppedWaitNote, type TicketFiles } from "./schedule.ts";
import { holdForUsage, readPause } from "./detach.ts";
import { expandTouches, parseTouches, unmergeableFiles } from "./touches.ts";
import { blockerChain } from "./lint.ts";

// Where they lived before landing.ts and ledger.ts; callers and tests still import them from here.
export { abortLanding, mergeBranch } from "./landing.ts";
export { closeComment, notLandedComment, pipelineOutcome, refusedRecord } from "./ledger.ts";

type Issue = Ticket;
type Outcome = {
  issue: string;
  branch: string;
  // "green", never "shipped": the pane titles said shipped while nothing had
  // landed, and the status table said queued - a run read as going in circles.
  status: "green" | "gate-failed" | "nochange" | "merged-earlier" | "held" | "conflict";
  /**
   * What its branch no longer merged onto the base with (`conflict`), found on the host before its review or its
   * gates: the pipeline stopped there, and the scheduler sends it back to resolve the merge (`conflictBefore`).
   */
  conflict?: Conflict;
  /** Why the kit held a finished branch for a person (`held`): nothing was handed back by an agent. */
  heldNote?: string;
  /** The agent handed the ticket back through the tracker's hold label (`nochange`), read as the pipeline ended (`handBack`). */
  handedBack?: boolean;
  commits: number;
  /** The branch tip the gates passed on; landing refuses a branch that moved since. */
  head?: string;
  reviewCommits: number;
  /** The repair passes that committed: one that changed nothing (the repairer judged the red a flake) is `idleRepairs`. */
  repairs: number;
  idleRepairs?: number;
  gates: Gate[];
  /** Test ids the last red gate named. */
  failing?: string[];
  /** Its branch had work from an earlier run: landing takes it first. */
  carried?: boolean;
  /** Repaired green, but the review of the repair failed: held, never merged unreviewed. */
  unreviewed?: boolean;
  /** What a reviewer said no gate exercises (its <ungated> line), for the closing summary. */
  ungated?: string;
  /** The `<changelog>` lines of the implementer and reviewers (`changelog: true`), for the closing summary. */
  changelog?: string[];
  /** How many `<changelog>` tags were no changelog line (too long, a list, a commit sha) and were left out: the summary says so. */
  changelogDropped?: number;
  /** The acceptance criterion an agent knowingly left undone (its <unmet> line): the branch lands, the ticket stays open. */
  unmet?: string;
  /** What a reviewer said in prose about a gap it filed neither as a `<followup>` nor as an `<unmet>` line (`gapOf`), for the closing summary. */
  gap?: string;
};

/**
 * A green branch's conflict resolution the kit held (`strayChanges`). The branch is a finished one,
 * so it reports what it carries - its commits and the gates it passed at its green head - not the
 * nothing of a ticket that did no work.
 */
export const heldResolution = (issue: string, branch: string, heldNote: string, carried: Pick<Outcome, "commits" | "reviewCommits" | "gates"> & Partial<Pick<Outcome, "repairs" | "idleRepairs">>): Outcome => ({
  issue,
  branch,
  status: "held",
  heldNote,
  repairs: 0,
  ...carried,
});

/**
 * The kept worktree of a pipeline that ended with no commits: the agent finished and its commit
 * was refused (a git hook, a full disk, a signing failure), so Sandcastle kept the worktree for
 * its uncommitted files. That is not "nothing to change" - the work exists.
 */
export const keptFor = (o: Pick<Outcome, "issue" | "status" | "commits">, kept: { issue: string; path: string }[]) =>
  o.status === "nochange" && o.commits === 0 ? kept.find((k) => k.issue === o.issue) : undefined;

/** A kept worktree as the record shows it: relative to the project, as the worktrees live in .sandcastle/worktrees/<name>. */
export const keptPath = (root: string, path: string) => {
  const inside = relative(root, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : path;
};

/** The run's own steps, timed beside a ticket's states: they are the run line's `stage`, never a ticket's state. */
type Stage = "image" | "preflight" | "hook check" | "base gates" | "verify";

/**
 * The `.git` check after a pipeline's sandbox closed, in the pipeline's `finally`. A failure is
 * kept (`kept`) for the attempt, which stops the run with it, and never thrown: thrown from the
 * `finally`, it replaced a red or no-change pipeline's result, which was then recorded as a
 * finished branch that "lands on a later run".
 */
export const settleAfter = async (settle: () => Promise<void>, kept: (error: unknown) => void): Promise<void> => {
  try {
    await settle();
  } catch (error) {
    kept(error);
  }
};

/**
 * What one attempt reports of its pipeline: what it returned or threw, and the `.git` check after
 * it (`check`, when that failed), which stops the run. A green branch is then stopped - finished,
 * it lands on a later run; any other result keeps its own ending, and a crash its own error.
 * `limited`: the crashed pipeline's agent hit the plan's usage limit.
 */
export const attempted = (issue: string, result: PromiseSettledResult<Outcome>, check?: { error: unknown }, limited = false): Attempted<Outcome, Outcome> => {
  const tampered: StopCause[] = check ? [{ kind: "tampered", error: check.error }] : [];
  // Parked by a pause when the run stopped: thrown on to the scheduler, which ends it as parked, with the check -
  // dropped, a `.git` change found after a non-safety stop went unreported, as no check closes the run.
  if (result.status === "rejected" && result.reason instanceof StoppedWhileParked) throw new StoppedWhileParked(tampered);
  if (result.status === "rejected") return { kind: "crashed", error: result.reason, causes: [...tampered, ...(limited ? [{ kind: "plan limit" as const, ticket: issue }] : [])] };
  const value = result.value;
  if (value.status === "green" || value.status === "merged-earlier") return check ? { kind: "stopped", cause: tampered[0] } : { kind: "green", green: value };
  // Never pushed on as green: the gates vouched for no commit of it. The requeue-once rule decides what comes next.
  if (value.status === "conflict" && value.conflict) return { kind: "conflict", outcome: value, conflict: value.conflict, ...(check && { causes: tampered }) };
  return { kind: "pipeline", outcome: value, ...(check && { causes: tampered }) };
};

/**
 * An agent that can write to the tracker (GitHub) hands a ticket back itself - hold label on, queue
 * label off - and commits nothing, so its pipeline ends as nochange. Read in the attempt as the
 * pipeline ends, so its ending arrives complete: reported as "nothing to change", a question for a
 * human read as a ticket that needed no work. Work left uncommitted is a refused commit, not a
 * hand-back; a dry run's agents write nothing; an unreadable tracker leaves it "no change".
 */
export const handBack = (o: Outcome, tracker: Pick<Tracker, "agentsWrite" | "get">, at: { uncommitted: boolean; dryRun: boolean }): Outcome => {
  if (!tracker.agentsWrite || at.dryRun || o.status !== "nochange" || at.uncommitted) return o;
  try {
    return tracker.get(o.issue).held ? { ...o, handedBack: true } : o;
  } catch {
    return o;
  }
};

// What an issue's pane and sidebar entry say when its pipeline ends - the
// status table's words, so the two never disagree.
const finishWord = (o: Outcome) =>
  ({ green: "ready to land", "gate-failed": "gate red", nochange: "no change", "merged-earlier": "ready to land", held: "needs a human", conflict: "merge conflict" })[o.status];

// A fence one backtick longer than any run inside, so gate output cannot
// close it and carry on as prompt text.
const fence = (text: string) => {
  const f = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${f}\n${text}\n${f}`;
};

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

// A spent plan allowance fails every issue after it the same way, each one
// after paying for a sandbox and an install. The first one stops the queue.
// Only what each log's latest pass wrote counts (`passStarts`), as in `passHitLimit`: a re-run that fails early would
// otherwise read the limit message of the pass before it and stop the queue for the wrong reason.
export const hitLimit = (root: string, issue: string) => {
  const logs = join(root, ".sandcastle/logs");
  if (!existsSync(logs)) return false;
  return readdirSync(logs)
    // Not the .jsonl sidecar: its last lines are raw tool results, and a file the agent merely read could say "usage limit".
    .filter((f) => f.endsWith(".log") && logOwner(f) === issue)
    .some((f) => {
      const log = readFileSync(join(logs, f));
      const from = passStarts.get(f) ?? 0;
      return logSaysLimit(log.subarray(log.length < from ? 0 : from).toString("utf8"));
    });
};

// Where each agent log's latest pass began, by the log's file name (they all live in .sandcastle/logs): Sandcastle appends a re-run to the same log.
export const passStarts = new Map<string, number>();

// How many bytes a pass's readable log holds before the pass starts. Sandcastle appends to the same log when a pass runs
// again, so what the pass itself wrote is what follows this offset.
const logSize = (logging: { type?: string; path?: string } | undefined) => {
  try {
    return logging?.type === "file" && typeof logging.path === "string" ? statSync(logging.path).size : 0;
  } catch {
    return 0;
  }
};

// Whether this pass's own readable log ends saying the allowance is spent: not another pass's of the ticket, whose log an
// earlier run may have left that way, so a pass that failed for another reason is never taken for the limit. Only what the
// pass wrote after `from` counts: a re-run that fails early writes fewer lines than the tail `logSaysLimit` reads, and the
// limit message of the pass before it would be read again.
const passHitLimit = (logging: { type?: string; path?: string } | undefined, from: number) => {
  try {
    if (logging?.type !== "file" || typeof logging.path !== "string") return false;
    const log = readFileSync(logging.path);
    // A log shorter than before the pass was rewritten, not appended to: all of it is this pass's.
    return logSaysLimit(log.subarray(log.length < from ? 0 : from).toString("utf8"));
  } catch {
    return false;
  }
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
// The texts of every `<tag>...</tag>` an agent put on lines of its own, in order. A tag named in
// prose - inside inline code, a fenced block or mid-sentence - is the agent explaining, not
// reporting, and the lazy match would otherwise run from that mention to the next real closing
// tag and record the prose between. So fenced blocks are blanked first, then the opening tag must
// start its line and the closing tag end one (the prompts ask for "a line of its own"); the
// content may still wrap over several lines but never holds another opening tag. A fence never closed blanks nothing: dropping a real
// tag after a stray one costs more than reading a mention.
const ownLineTags = (text: string, tag: string): string[] => {
  const unfenced = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "");
  return [...unfenced.matchAll(new RegExp(`^[ \\t]*<${tag}>((?:(?!<${tag}>)[\\s\\S])*?)</${tag}>[ \\t]*$`, "gm"))].map((m) => m[1]);
};
const lineOf = (tag: string) => (text: string): string | undefined => {
  const said = ownLineTags(text, tag).at(-1)?.replace(/\s+/g, " ").trim();
  return said && said !== "..." ? cutAtWord(said, UNGATED_MAX) : undefined;
};
export const ungatedOf = lineOf("ungated");
// An agent's `<unmet>...</unmet>` line: the acceptance criterion it knowingly left undone. Read the same way.
export const unmetOf = lineOf("unmet");
// What a full review is shown of the implementer's `<unmet>` line: its words are dropped from the ticket's
// leftovers once a full review ran (`left`), so the reviewer must finish the criterion or restate it, or it is lost.
// Empty when the implementer gave none, so the prompt carries no heading over nothing.
export const implUnmetView = (unmet: string | undefined): string =>
  unmet
    ? "# What the implementer left undone\n\nThe implementer ended with this `<unmet>` line, naming an acceptance criterion it knowingly left undone:\n\n" +
      `> ${unmet}\n\n` +
      "Finish it yourself, or restate it in your own `<unmet>` line. A criterion your final message neither " +
      "finishes nor restates is dropped from the ticket as done.\n\n"
    : "";

// The `<changelog>...</changelog>` lines of one agent's final message, each one line, in order.
// Unlike `<ungated>` every own-line tag counts, not the last alone: a ticket may need several lines. An
// empty tag or the echoed placeholder "..." does not count. A changelog line is one or two sentences, so a
// tag that is longer than CHANGELOG_MAX, spans list items or holds a commit sha is an agent's whole message
// (a prose mention of the tag can pair with a later closing tag), not a line: it is counted in `dropped`
// and never shown, least of all cut off.
export const CHANGELOG_MAX = 500;
const listItem = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]/m;
const commitSha = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
export const changelogRead = (text: string): { lines: string[]; dropped: number } => {
  const lines: string[] = [];
  let dropped = 0;
  for (const raw of ownLineTags(text, "changelog")) {
    const said = raw.replace(/\s+/g, " ").trim();
    if (!said || said === "...") continue;
    if (said.length > CHANGELOG_MAX || listItem.test(raw) || commitSha.test(said)) dropped++;
    else lines.push(said);
  }
  return { lines, dropped };
};
export const changelogOf = (text: string): string[] => changelogRead(text).lines;

// Adds one pass's lines to the ticket's and returns how many tags were no line. A full review that gives
// any lines gives the full set for the branch (its prompt asks it to restate the implementer's along with
// its own), so its set replaces the earlier one: a rewording then shows once however few words it shares,
// and a distinct change that shares words is not dropped for it. A narrow pass (after a conflict
// resolution, a base merge or a repair) sees only what it reviewed, not the branch: its set is lines for
// what it changed itself, so it adds to the earlier set - replacing would drop every line the implementer
// gave. A pass that gives none leaves the earlier set standing. Two lines of one pass are two changes,
// however alike their words ("`size --json` prints ..." and "`status --json` prints ...").
export const addChangelog = (have: string[], text: string, narrow = false): number => {
  const read = changelogRead(text);
  if (!read.lines.length) return read.dropped;
  if (narrow) {
    for (const line of read.lines) if (!have.includes(line)) have.push(line);
  } else have.splice(0, have.length, ...read.lines);
  return read.dropped;
};

/** A problem outside its ticket that an agent named in a `<followup>` line: the kit files it for triage once the run has landed. */
export type FollowUp = { title: string; evidence: string; from: string; phase: string };
/** A follow-up as the run record keeps it: `id` is the ticket filed, absent in a dry run (which files nothing) or when filing failed (`failed`). */
export type FiledFollowUp = { title: string; from: string; phase: string; id?: string; failed?: string };

// A ticket title is short: a longer one is a paragraph, cut at a word. GitHub refuses more than 256.
export const FOLLOWUP_TITLE_MAX = 120;
// Every own-line `<followup>title - evidence</followup>` of one final message, in order. An agent that
// left a problem in prose lost it (nobody reads the message), so the kit reads these and files them.
// The title is what comes before the first " - "; the echoed placeholder counts for nothing.
const followUpsOf = (text: string): Omit<FollowUp, "from" | "phase">[] =>
  ownLineTags(text, "followup").flatMap((raw) => {
    const said = raw.replace(/\s+/g, " ").trim();
    if (!said || said === "..." || said === "title - one line of evidence") return [];
    const at = said.indexOf(" - ");
    const title = (at > 0 ? said.slice(0, at) : said).trim();
    return [{ title: cutAtWord(title, FOLLOWUP_TITLE_MAX), evidence: at > 0 ? said.slice(at + 3).trim() : "" }];
  });
// A reviewer that names a known gap in prose and files it as neither a `<followup>` nor an `<unmet>` line
// loses it: nobody reads the message. The words that name one, as a person writes them ("left alone",
// "remains", "a gap", "not fixed"); the wording of the prompts alone did not hold.
const GAP_WORDS = /\b(?:left\s+(?:alone|unfixed|as\s+is|undone)|remains?|remaining|gaps?|not\s+(?:fixed|addressed|handled)|unfixed|unaddressed|still\s+(?:fails?|broken|wrong))\b/i;
// What the same words say when they report there is nothing left ("nothing remains", "no gaps", "no remaining
// issue"), and a thing that "remains green" or "remains unchanged" - or "unaffected", the platform sentence
// every review prompt asks for, which would otherwise list nearly every merged ticket. Also "the remaining tests
// pass", "every remaining criterion is met" and a test that "covers the gap the ticket describes": a first run
// flagged each of these as a gap.
const GAP_NEGATED =
  /\b(?:nothing|none|no|neither|without|zero)\b(?:\s+\w+){0,3}?\s+(?:remains?|remaining|gaps?)\b|\bremains?\s+(?:unchanged|unaffected|untouched|green|correct|valid|intact|passing|accurate|true|compatible|in\s+place|the\s+same|as\s+(?:is|before|it\s+was))\b|\b(?:no|nothing|none)\b[^.]*\bleft\s+(?:alone|unfixed)\b|\b(?:every|each|all(?:\s+the)?)\s+remaining\b|\bremaining\s+(?:\w+\s+){0,3}?(?:pass(?:es|ed)?|(?:is|are)\s+(?:met|green|fine|done)|hold)\b|\b(?:covers?|covered|clos(?:es|ed|e)|fill(?:s|ed)?|fix(?:es|ed)?|address(?:es|ed)?)\s+(?:the|this|that|a)\s+gap\b/i;
// The sentences of a message, read as a person would: a tag's content (`<ungated>`, `<changelog>`) and a
// fenced block are no prose, a list item is a unit of its own, and a paragraph's wrapped lines join.
const sentencesOf = (text: string): string[] => {
  const prose = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "").replace(/<(\w+)>[\s\S]*?<\/\1>/g, "");
  const units: string[] = [];
  let open = false;
  for (const raw of prose.split("\n")) {
    const line = raw.replace(/^[ \t]*>+[ \t]?/, "").trim();
    if (!line) open = false;
    else if (open && !/^(?:[-*+•]|\d+[.)])\s/.test(line)) units[units.length - 1] += ` ${line}`;
    else {
      units.push(line);
      open = true;
    }
  }
  return units.flatMap((u) => u.split(/(?<=[.!?])\s+(?=[A-Z"`(*])/)).map((s) => s.replace(/^(?:[-*+•]|\d+[.)])\s+/, "").trim());
};
// The gap sentences of a reviewer's final message, when it filed none: a message with a `<followup>` or an
// `<unmet>` line has said it the way the kit reads. Several sentences are one note.
const gapOf = (text: string): string | undefined => {
  if (followUpsOf(text).length || unmetOf(text)) return undefined;
  const said = sentencesOf(text).filter((s) => GAP_WORDS.test(s) && !GAP_NEGATED.test(s));
  return said.length ? cutAtWord([...new Set(said)].join(" "), UNGATED_MAX) : undefined;
};
// The phase a pass's name says, in the words a person reads in the filed ticket.
const phaseOf = (name: string) =>
  name.startsWith("impl-") ? "implement" : name.startsWith("review-codex-") ? "cross-review" : name.startsWith("review-") ? "review" : name.split("-")[0];
// One problem named by two agents, or twice by one, is one ticket.
const titleKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();
// A `path:line` an agent names, in the title first, else the evidence: the other way two passes of one
// ticket (implement, review) say the same finding in different words. The first one named is the finding's
// place; a path is `dir/file.ext` or `file.ext`, so a `host:8080` or a bare `word:3` is not one.
const PLACE = /(?<![\w@.:/-])((?:[\w@.-]+\/)*[\w@-]+(?:\.[\w-]*[A-Za-z][\w-]*)+):(\d+)/;
// Per source ticket: the same place named for another ticket is a different finding.
const placeKey = (f: FollowUp): string | undefined => {
  const at = PLACE.exec(f.title) ?? PLACE.exec(f.evidence);
  return at ? `${f.from}\0${at[1].replace(/^\.\//, "")}:${Number(at[2])}` : undefined;
};
// What was said again about an issue already filed, as the comment on it.
const repeatComment = (f: FollowUp, ref: (id: string) => string) =>
  `Named again by the ${f.phase} agent working on ${ref(f.from)}, at the same place, as "${f.title}":\n\n${f.evidence || "(no evidence given)"}`;
// The titles filed by every turn of this `sandcastle run`: a turn that re-runs a ticket (partly done,
// requeued) hears its agents name the same problem again, and that is still one ticket.
const filedThisRun = new Set<string>();
// The issue each place was filed as, by every turn of this run (`placeKey`): the same finding in other words is a comment on it.
const placesThisRun = new Map<string, string>();

/**
 * Files each follow-up as a new ticket for triage through the project's tracker (`create`), its body
 * naming the source ticket and phase, a title already filed in this run once. A follow-up naming the
 * same `path:line` as one already filed for the same source ticket, whatever its title, is not filed:
 * its evidence is a comment on that issue (`places` holds the issue of each place) and it is not
 * returned, unless the comment fails. A dry run files nothing and returns them unfiled, for the summary to list.
 * `write` is how a tracker write is made (the host's git mutex in a run: a ticket file is a commit on
 * the base). `seen` is the titles already filed, shared by a run's turns. A failed filing is kept with
 * its reason, never thrown, and its title left unseen for a later turn to file: the run's landings stand.
 */
export const fileFollowUps = async (
  tracker: Pick<Tracker, "create" | "ref" | "comment">,
  followUps: readonly FollowUp[],
  o: { dryRun: boolean; write: (fn: () => string) => Promise<string>; seen?: Set<string>; places?: Map<string, string> },
): Promise<FiledFollowUp[]> => {
  const seen = o.seen ?? new Set<string>();
  const places = o.places ?? new Map<string, string>();
  const out: FiledFollowUp[] = [];
  for (const f of followUps) {
    const key = titleKey(f.title);
    if (seen.has(key)) continue;
    const at = { title: f.title, from: f.from, phase: f.phase };
    const place = placeKey(f);
    const first = place && !o.dryRun ? places.get(place) : undefined;
    if (first !== undefined) {
      try {
        await o.write(() => {
          tracker.comment(first, repeatComment(f, tracker.ref));
          return first;
        });
        seen.add(key);
      } catch (error) {
        out.push({ ...at, failed: errorLine(error) });
      }
      continue;
    }
    if (o.dryRun) {
      seen.add(key);
      out.push(at);
      continue;
    }
    const body =
      `${f.evidence || "(no evidence given)"}\n\n` +
      `Reported by the ${f.phase} agent working on ${tracker.ref(f.from)} as outside that ticket, and filed by sandcastle for triage: queue it or close it.`;
    try {
      const id = await o.write(() => tracker.create(f.title, body, f.from));
      out.push({ ...at, id });
      seen.add(key);
      if (place) places.set(place, id);
    } catch (error) {
      out.push({ ...at, failed: errorLine(error) });
    }
  }
  return out;
};

/**
 * What the pipelines' `<followup>` lines go into, and the run record behind it. Each line is written to
 * the record as its pass ends, as an unfiled entry (no `id`): a run that stops before its end (a crash,
 * a safety stop) never reaches the filing after the landings, and its lines were then in memory only -
 * not in the closing summary, and unknown to the next run. A title is listed once, and not at all when
 * an earlier turn of the run filed it (`seen`). A line naming the `path:line` of one already heard for
 * the same source ticket (`placeKey`) is not listed: it is held until that one is filed, and then
 * commented on its issue. Held, it is retried by each `file` until it is commented; one whose first
 * failed to file stays held, and a dry run lists and comments none.
 *
 * `file` files the entries still unfiled (`fileFollowUps`) and writes what each became to the record, and
 * returns those it settled now: calling it again files nothing twice, and a title whose filing failed is
 * not tried again by it. `unsafe` is the reason when writing to the tracker is not safe - the shared
 * `.git` changed - and then nothing is written: each stays in the record as failed with that reason, which
 * the summary lists under Needs you as one to file by hand. A dry run writes nothing either way, so
 * `unsafe` changes nothing for it.
 */
export type FollowUpBook = {
  push(f: FollowUp): void;
  file(unsafe?: string): Promise<FiledFollowUp[]>;
};
export const createFollowUpBook = (
  run: { update(fields: { followUps: FiledFollowUp[] }): void },
  o: {
    tracker: Pick<Tracker, "create" | "ref" | "comment">;
    dryRun: boolean;
    write: (fn: () => string) => Promise<string>;
    seen?: Set<string>;
    places?: Map<string, string>;
  },
): FollowUpBook => {
  const seen = o.seen ?? new Set<string>();
  const places = o.places ?? new Map<string, string>();
  const heard: FollowUp[] = [];
  // The same finding as a listed one, in other words: comments on its issue once there is one.
  let repeats: FollowUp[] = [];
  const listedPlaces = new Set<string>();
  // By title, in the order the lines arrived: what the run record's `followUps` holds.
  const listed = new Map<string, FiledFollowUp>();
  const keep = () => run.update({ followUps: [...listed.values()] });
  return {
    push(f) {
      const key = titleKey(f.title);
      if (seen.has(key)) return;
      if (!listed.has(key)) {
        const place = placeKey(f);
        if (place && (listedPlaces.has(place) || places.has(place))) {
          repeats.push(f);
          return;
        }
        if (place) listedPlaces.add(place);
      }
      heard.push(f);
      if (listed.has(key)) return;
      listed.set(key, { title: f.title, from: f.from, phase: f.phase });
      keep();
    },
    async file(unsafe) {
      const unfiled = heard.filter((f) => {
        const at = listed.get(titleKey(f.title));
        return at && !at.id && !at.failed;
      });
      const refuse = unsafe !== undefined && !o.dryRun;
      const settled = await fileFollowUps(o.tracker, unfiled, {
        dryRun: o.dryRun,
        // Not the tracker's own refusal, but recorded as one: it is the same entry, and the same line to file by hand.
        write: refuse ? async () => { throw new Error(unsafe); } : o.write,
        seen,
        places,
      });
      if (settled.length) {
        for (const s of settled) listed.set(titleKey(s.title), s);
        keep();
      }
      if (!o.dryRun && !refuse) {
        repeats = repeats.filter((f) => !seen.has(titleKey(f.title)));
        const ready = repeats.filter((f) => places.has(placeKey(f)!));
        // A comment that fails is not recorded: it stays held, and the next `file` tries it again.
        if (ready.length) await fileFollowUps(o.tracker, ready, { dryRun: false, write: o.write, seen, places });
        repeats = repeats.filter((f) => !seen.has(titleKey(f.title)));
      }
      if (!settled.length) return [];
      return [...new Set(settled.map((s) => titleKey(s.title)))].map((key) => listed.get(key)!);
    },
  };
};

/** The tickets `TICKETS` (or `ISSUES`, its older name; or `sandcastle run 12 15`) names, refused before anything starts when one is closed. */
export const namedTickets = (tracker: Tracker, list: string): Issue[] =>
  list.split(",").map((n) => {
    const t = tracker.get(n.trim());
    if (!t.open) throw new OperatorError(`${tracker.ref(t.id)} is closed, so a run would not work on it. Leave it out, or reopen it first.`);
    return t;
  });

/**
 * What a ticket's gates run is called in the pool's wait line. It names the project, as the landing
 * label does: with several projects' runs on one machine, "#252 gates" says nothing of which run waits.
 */
export const gatesLabel = (project: { name: string }, ref: (id: string) => string, id: string, what = "gates"): string => `${project.name} ${ref(id)} ${what}`;

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

/** A typical issue's length in ms, from `typicalTimes`' seconds; undefined with no history. */
export const typicalIssueMs = (typical: Record<string, number>): number | undefined => (typical.issue ? typical.issue * 1000 : undefined);

/** Ms as the heartbeat and the per-issue lines say them: `45s`, `120m`. */
const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

/**
 * The run's heartbeat: the tickets working and their step, the landings in flight (and the step each is at, once
 * it says one), the sent-back tickets waiting to resolve, then the run's wait for a sandbox slot (`slotWait`, when
 * its oldest open wait began; `createSlotWaits`) once it is longer than a typical issue takes (`typicalMs`; with
 * no history nothing is said, as the estimate says nothing then). The wait is the run's, not a ticket's: a worker
 * leases its slot before it takes a ticket. No line when none of these is in flight.
 */
export const heartbeatLine = (o: {
  now: number;
  clock: string;
  working: { ref: string; phase: string; since: number }[];
  landing?: { ref: string; phase?: string; since: number }[];
  resolving?: { ref: string; since: number }[];
  slotWait?: number;
  typicalMs?: number;
}): string | undefined => {
  const stalled = o.typicalMs !== undefined && o.slotWait !== undefined && o.now - o.slotWait > o.typicalMs;
  const parts: string[] = [];
  if (o.working.length) parts.push(`working: ${o.working.map((w) => `${w.ref} ${w.phase} ${minutes(o.now - w.since)}`).join(", ")}`);
  if (o.landing?.length) parts.push(`landing: ${o.landing.map((w) => `${w.ref}${w.phase ? ` ${w.phase}` : ""} ${minutes(o.now - w.since)}`).join(", ")}`);
  if (o.resolving?.length) parts.push(`waiting to resolve a conflict: ${o.resolving.map((w) => `${w.ref} ${minutes(o.now - w.since)}`).join(", ")}`);
  if (stalled) parts.push(`waiting for a sandbox slot: ${minutes(o.now - o.slotWait!)}`);
  return parts.length ? `[${o.clock}] ${parts.join("; ")}` : undefined;
};

/**
 * The run's waits for a machine-wide sandbox slot: a pipeline worker's for the next ticket (slot first,
 * `Work.slot` in src/schedule.ts) and a ticket's own as a pause ends. None of them is a ticket's in the queue, so
 * what they say is the run's: `share` is told each time "a wait is held back by the run's share" turns true or
 * false (the run record's `waitsForShare`), and `since` is when the oldest wait still open began (the heartbeat).
 * Each wait `begin`s as it asks the pool, hands the pool's reason to `onWait`, and `end`s as it is served or given up.
 */
export const createSlotWaits = (share: (held: boolean) => void, now: () => number = Date.now) => {
  const open = new Map<object, { since: number; share: boolean }>();
  let told = false;
  const tell = () => {
    const held = [...open.values()].some((w) => w.share);
    if (held === told) return;
    told = held;
    share(held);
  };
  return {
    begin() {
      const key = {};
      open.set(key, { since: now(), share: false });
      return {
        onWait(why: WaitReason) {
          const wait = open.get(key);
          if (!wait) return;
          wait.share = why === "share";
          tell();
        },
        end() {
          open.delete(key);
          tell();
        },
      };
    },
    get since(): number | undefined {
      const all = [...open.values()].map((w) => w.since);
      return all.length ? Math.min(...all) : undefined;
    },
  };
};

/**
 * The run record's side of the file hold. `start`: each ticket `createSchedule` parked behind a file
 * is said and put on `waiting` (before the run record exists), and the mergeable files that tickets
 * starting together share are named, one line per file (`fileShareSummary`; the pair list goes to `log`). `tell`: what the scheduler tells of the hold as the run goes -
 * a ticket that starts, one that waits (and for whom now), one left for the next run - written to
 * the record, with `waiting` naming the ticket in flight each waits for now, never one that is gone.
 */
export const createHoldRecord = (o: { waiting: { issue: string; on: string[] }[]; ref(id: string): string; say(line: string): void; log?(line: string): void }) => {
  // Every ticket started so far: `waiting` is the start-of-run list, so each write filters against all of them.
  const started = new Set<string>();
  // The status view's queue position (`order`) follows the scheduler's start queue: a requeued ticket
  // goes before a released one, and both before every ticket not yet started, whose order is its place
  // in `start` (from 0). Each kind in the order it arrived, so the view's "next to start" is true.
  const AHEAD = 1_000_000;
  let sentBack = 0;
  let released = 0;
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
  // One line per file, not per pair: the pairs of a wide run number in the dozens. The pairs go to the log.
  const sayShares = (pairs: { id: string; share: FileShare }[]) => {
    const lines = fileShareSummary(o.ref, pairs);
    if (!lines.length) return;
    o.say("  tickets that share files; if they conflict at landing, the later one is sent back once and its merge resolved:");
    for (const line of lines) o.say(`    ${line}`);
    for (const { id, share } of pairs) o.log?.(fileShareLine(o.ref, id, share));
  };
  return {
    start(candidates: readonly Start<{ id: string }>[]) {
      const pairs: { id: string; share: FileShare }[] = [];
      for (const { ticket, file, shares } of candidates) {
        if (file) {
          o.waiting.push({ issue: ticket.id, on: [o.ref(file.with)] });
          o.say(`  ${o.ref(ticket.id)} ${fileWaitNote(o.ref, file)}`);
        }
        for (const share of shares ?? []) pairs.push({ id: ticket.id, share });
      }
      sayShares(pairs);
    },
    tell(run: Record, c: HoldChange | { kind: "requeued"; id: string }) {
      switch (c.kind) {
        case "requeued":
          run.ticket(c.id, { order: sentBack++ - 2 * AHEAD });
          return;
        case "started":
          started.add(c.id);
          o.say(`  ${o.ref(c.id)} ${c.after.kind === "blockers" ? "released: its last blocker has landed; it starts at the next free slot" : `starts: ${o.ref(c.after.freed)} is done with the file they both change`}`);
          sayShares(c.shares.map((share) => ({ id: c.id, share })));
          run.ticket(c.id, { state: "queued", note: null, ...(c.after.kind === "blockers" && { order: released++ - AHEAD }) });
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
          return;
        case "resolve waits": {
          const note = resolveWaitNote(o.ref, c);
          // Said once: a list that changes later updates the record's note, not the log.
          if (c.first) o.say(`  ${o.ref(c.id)} ${note}: a resolve made now would conflict again with the landing of a ticket that shares its files`);
          run.ticket(c.id, { note });
          return;
        }
        case "resolve starts":
          o.say(`  ${o.ref(c.id)} resolves its conflict now: nothing that shares its files is left to land`);
          run.ticket(c.id, { note: null });
      }
    },
  };
};

/**
 * A resolve wait's note: the branches queued to land have landed, and a ticket still in its pipeline "lands or
 * leaves the run" - it may never reach a landing, so "has landed" would promise one.
 */
export const resolveWaitNote = (ref: (id: string) => string, c: { for: string[]; running: string[] }): string => {
  const list = (ids: string[], one: string, many: string) => `${ids.map(ref).join(", ")} ${ids.length > 1 ? many : one}`;
  const queued = c.for.filter((id) => !c.running.includes(id));
  const parts = [...(queued.length ? [list(queued, "has landed", "have landed")] : []), ...(c.running.length ? [list(c.running, "lands or leaves the run", "land or leave the run")] : [])];
  return `waits to resolve its conflict until ${parts.join(" and ")}`;
};

/** The hold notes, an agent's <blocked> or the kit's own hold: the ledger says the ticket is held, and gives it no second comment. */
type Note = { issue: string; kind: "hold"; text: string };

/** One step of a run or a ticket, timed into logs/timings.jsonl and the run record (burndown's `timed`). */
export type Timed = <T>(issue: string, phase: TicketState | Stage, fn: () => Promise<T> | T, note?: string, model?: () => string | undefined, queuedMs?: number) => Promise<T>;

/**
 * The `started` a step's run.json write carries: at the ticket's first `setup` only, kept through a
 * requeued second attempt or a resume, as the status view's TIME for a finished ticket is
 * `since - started`, its whole wall time, not its last attempt's. `attemptStarted` is every `setup`'s:
 * the ETA counts a working ticket's time left from it, and from the first start a second attempt after a
 * long first one read as overdue.
 */
export const firstStart = (prior: TicketRecord | undefined, phase: TicketState, sinceMs: number): { started?: number; attemptStarted?: number } => {
  if (phase !== "setup") return {};
  const at = Math.floor(sinceMs / 1000);
  return typeof prior?.started === "number" ? { attemptStarted: at } : { started: at, attemptStarted: at };
};

/**
 * The summary line's time for a ticket: its work. A wait for a machine-wide sandbox slot is no ticket's: a worker
 * leases its slot before it takes a ticket (slot first), so the wait is the run's (`createSlotWaits`).
 */
export const ticketTime = (workMs: number | undefined): string => {
  const work = workMs === undefined ? "" : workMs < 60_000 ? `${Math.round(workMs / 1000)}s` : `${Math.round(workMs / 60_000)}m`;
  return work && ` ${work}`;
};

/** A ticket's sandbox as its pipeline uses it: `run` is every agent pass, `exec` every git command in it. */
export type PipelineBox = Pick<Sandbox, "worktreePath" | "exec" | "run" | "close">;

/**
 * What one ticket's pipeline works through, as `LandContext` is what a landing does: its sandbox
 * (`open`, whose `run` is each agent pass), its gate runs (`gate`), the step timer and what the run
 * keeps across attempts. burndown() gives the real ones; a test gives fakes, so the pipeline - the
 * requeue's repair count, the gate run skipped on an unmoved base - runs with no Docker or model.
 */
export type PipelineContext = {
  project: Project;
  tracker: Tracker;
  runId: string;
  dryRun: boolean;
  /** Repair passes per attempt (`repair.attempts`). */
  repair: number;
  /** SANDCASTLE_TEST_RED_GATE: the first gate run counts as red, to test the repair pass. */
  testRedGate: boolean;
  prompts: ReturnType<typeof renderPrompts>;
  /** Each ticket's own implementer (its `model:` and `effort:` labels). */
  overrides: ReadonlyMap<string, Override>;
  /** Opens the ticket's sandbox on its branch: Sandcastle's `createSandbox` in a run. */
  open: (branch: string) => Promise<PipelineBox>;
  /** One run of the project's gates in the ticket's sandbox. */
  gate: (box: PipelineBox, id: string) => Promise<GateRun>;
  /** Every gate on the base's tip, in a sandbox of its own (`gateBase`): what a failure no branch caused is checked against. */
  baseGate: () => Promise<GateRun>;
  /** Tests found red on the base mid-run, told once each: the run record keeps them for the closing summary. */
  baseWentRed: (tests: string[]) => void;
  timed: Timed;
  run: { ticket(id: string, fields: TicketRecord): void };
  view: Pick<SandboxView, "claim">;
  host: Pick<HostGit, "begin" | "settle">;
  /** The requeue-once state: a requeued ticket's line, while its second attempt is to come. */
  requeuedAs: ReadonlyMap<string, string>;
  /** This run's pipeline results so far: a requeued ticket's first attempt is among them. */
  results: readonly PromiseSettledResult<Outcome>[];
  /** Each ticket's red landing gate, for its requeue (`repairFromRed`); read once, by its next pipeline. */
  reds: Map<string, RedLanding>;
  /** The tickets landed so far in this run, with the files each changed (`LandContext.landed`): who a branch that no longer merges collides with. None, and it is named with no one. */
  landed?: ReadonlyMap<string, { files: string[]; commit: string }>;
  /** Who is repairing which failure, shared by the run's pipelines: a ticket red on one another is repairing waits for that landing. A pipeline given none waits for no one. */
  fixes?: FixBoard;
  /** What the agents reported, by ticket, when they cannot write to the tracker. */
  reports: Map<string, string>;
  notes: Note[];
  /** Where the `<followup>` lines of every agent pass go as the pass ends: the run's book (`createFollowUpBook`), which records and later files them. A pipeline given none keeps none. */
  followUps?: { push(f: FollowUp): unknown };
  /** Each ticket's time in its pipelines, added up over its attempts. */
  took: Map<string, number>;
  /** Each ticket's waits inside `took` that are not its work - a gates slot, another ticket's fix - left out of its usual time. */
  waited?: Map<string, number>;
  /**
   * With `USAGE_PAUSE` set: an agent of the ticket hit the plan's usage limit during `phase`. Pauses the run until
   * the window resets and returns true - the pass then runs again after the resume - or false when no reading says
   * when that is, and the limit stops the queue as it does without the setting.
   */
  limitPause?: (phase: string) => boolean;
  /** Worktrees Sandcastle kept for their uncommitted files. */
  keptWorktrees: { issue: string; path: string }[];
  /** The `.git` check that failed after a ticket's pipeline, by ticket: its attempt stops the run with it. */
  tampered: Map<string, unknown>;
};

/** One ticket's pipeline: implement, review, gate with repair, in its own sandbox. */
export const createPipeline = (ctx: PipelineContext) => {
  const { project, tracker, runId, dryRun, repair, testRedGate, prompts, overrides, open, gate, baseGate, baseWentRed, timed, run, view, host, requeuedAs, results, reds, reports, notes, took, keptWorktrees, tampered } = ctx;
  const fixes = ctx.fixes ?? createFixBoard();
  const waited = ctx.waited ?? new Map<string, number>();
  const landed = ctx.landed ?? new Map<string, { files: string[]; commit: string }>();
  const base = project.baseBranch;
  const ref = tracker.ref;
  // A run that died between merging a branch and closing its issue leaves the
  // issue queued with its work already on base. Re-running it finds nothing
  // to do and reports `nochange`, so the issue would stay open for good. Our
  // own merge message finds it instead - unless someone reopened the issue
  // after that merge, which asks for more work, not for a close. Any doubt
  // (gh unreachable) means a normal run, which is what happened before.
  const mergedEarlier = (issue: string, branch: string) => {
    const found = sh("git", ["log", base, "-1", "--format=%h %cI", "--fixed-strings", `--grep=Merge ${branch} (closes ${ref(issue)})`], project.root);
    if (!found) return undefined;
    const [merge, mergedAt] = found.split(" ");
    return tracker.reopenedSince(issue, Date.parse(mergedAt)) ? undefined : merge;
  };

  const addReport = (id: string, heading: string, text: string) =>
    reports.set(id, [reports.get(id), `**${heading}**\n\n${text}`].filter(Boolean).join("\n\n"));

  // A later run skips work a branch already passed (see recordHead). A dry run's
  // work must not change what a real run skips, and a failed write never fails
  // the ticket: the cost is only that a re-run runs it in full.
  const noteHead = (id: string, branch: string, fields: { reviewed?: string; green?: string; red?: string; unmet?: string; gates?: Gate[]; changelog?: string[]; changelogDropped?: number; repaired?: string[] }) => {
    if (dryRun) return;
    try {
      recordHead(project.root, id, { branch, ...fields }, runId);
    } catch (error) {
      console.log(`${ref(id)}: could not record its head (${String(error).split("\n")[0].slice(0, 160)}); a re-run runs it in full.`);
    }
  };

  // A test that goes red on the base mid-run goes red on every branch that has the base merged in, and each
  // one's repair pass fixed it its own way: the fixes then conflicted at landing. A gate run on the base's tip
  // answers once per tip, for every branch red on the same failure (a promise, so branches red at the same
  // moment share one run).
  const baseRuns = new Map<string, Promise<GateRun>>();
  const toldRed = new Set<string>();
  /**
   * The failing tests of `failure` when they fail on the base's tip as well, and no file of them is one the
   * branch changed; otherwise undefined and the red is the branch's own. A test whose file the output does not
   * name, a list that may be cut and a gate with no failing tests (lint, types) are the branch's own: the kit
   * cannot run one test, so it never guesses. An id that names only a file (vitest's and jest's "FAIL path", a
   * node:test file that failed to load) says nothing of which test in it failed: a branch that broke one test in
   * a file where the base has a different one red prints the same id, so that red is the base's only when the
   * gate failed the same way on both (`failureKey`).
   */
  const redOnBase = async (failure: { name: string; output: string }, branch: string): Promise<string[] | undefined> => {
    const tests = failingTests(failure.output);
    if (!tests.length || tests.length >= FAILING_TESTS_SHOWN) return undefined;
    const files = tests.map(failingTestFile);
    if (files.some((f) => f === undefined)) return undefined;
    // Against the merge base: a branch that merged the base in has not changed what the base did.
    const changed = new Set(sh("git", ["diff", "--no-renames", "--name-only", `${base}...${branch}`], project.root).split("\n").filter(Boolean));
    if (files.some((f) => changed.has(f!))) return undefined;
    const tip = sh("git", ["rev-parse", base], project.root);
    let running = baseRuns.get(tip);
    if (!running) {
      const asked = baseGate();
      running = asked;
      baseRuns.set(tip, asked);
      asked.then(
        // The base sandbox is cut from the base's name: a landing since the tip was read means the run gated a
        // newer commit, so it is filed under that one, and the older tip has no answer of its own.
        (r) => {
          if (!r.head || r.head === tip) return;
          if (baseRuns.get(tip) === asked) baseRuns.delete(tip);
          if (!baseRuns.has(r.head)) baseRuns.set(r.head, asked);
        },
        // A base run that could not be made is no answer: the next red asks again.
        () => baseRuns.delete(tip),
      );
    }
    const onBase = await running.then((r) => r.failures.find((f) => f.name === failure.name), () => undefined);
    if (!onBase) return undefined;
    // The base's whole list: with five or more red there, the branch's test may be past the first five.
    const there = failingTests(onBase.output, Infinity);
    if (!tests.every((t) => there.includes(t))) return undefined;
    const fileOnly = tests.some((t) => !t.includes("::"));
    return fileOnly && failureKey(failure) !== failureKey(onBase) ? undefined : tests;
  };

  // Read once: `git --version` does not change during a run.
  let mergeTreeOk: boolean | undefined;
  /**
   * Whether `branch` still merges onto the base's tip, by git's own merge on the host as landing checks it (`landOne`):
   * the files that conflict and the tickets landed in this run that changed them, or undefined when it merges. Another
   * ticket that landed over the same lines leaves a branch whose review and gates landing would throw away - a review
   * of a doomed branch once took most of a run's lost time - so the pipeline asks before its review and again before
   * its gates. A conflict only in generated files is none (landing regenerates them), nor is a check that cannot run
   * (git older than 2.38, a git call that failed): the pipeline goes on as it did before.
   */
  const conflictBefore = (branch: string): Conflict | undefined => {
    try {
      mergeTreeOk ??= mergeTreeSupported(project.root);
      if (!mergeTreeOk) return undefined;
      const head = sh("git", ["rev-parse", branch], project.root);
      const files = [...mergeTree(project.root, sh("git", ["rev-parse", base], project.root), head).conflicted];
      if (!files.length || regensFor(files, project.generated)) return undefined;
      // The landed tickets this branch has never seen that changed a file of the conflict, as landing names them.
      const others = [...landed].filter(([, r]) => files.some((f) => r.files.includes(f)) && !isAncestor(project.root, r.commit, head)).map(([id]) => id);
      return { files, with: others };
    } catch {
      return undefined;
    }
  };

  // `at.juncture`: the scheduler's, awaited before each agent pass (see `juncture` below). Without it, nothing is held.
  // `at.resolveWaitMs`: a sent-back ticket's wait for the tickets ahead of its resolve, which came before the attempt:
  // the first `setup` step records it as its `waitMs`. No wait for a sandbox slot is a ticket's: its worker held the
  // slot before it took the ticket (slot first).
  return async (issue: Issue, at?: { juncture(phase: string, park?: Park): Promise<void>; paused?(): boolean; resolveWaitMs?: number }): Promise<Outcome> => {
    const branch = `agent/issue-${issue.id}`;
    // The ticket's own implementer, for the implement and repair passes only.
    const own = overrides.get(issue.id) ?? {};
    const implModel = own.model ?? IMPL_MODEL;
    // `IMPL_UNMET` and `IMPL_CHANGELOG` are empty here: only a full review is shown the implementer's unmet
    // line and changelog lines (see `implUnmetView`, `implChangelogView`).
    const promptArgs = { ISSUE_NUMBER: issue.id, TICKET: ref(issue.id), IMPL_UNMET: "", IMPL_CHANGELOG: "", ...tracker.promptArgs(issue.id) };
    const merge = mergedEarlier(issue.id, branch);
    if (merge) {
      return { issue: issue.id, branch, status: "merged-earlier", commits: 0, reviewCommits: 0, repairs: 0, gates: [], head: merge };
    }
    view.claim(issue.id, issue.title);

    const started = Date.now();
    releaseBranchWorktree(branch, project.root);
    // From here the agent commits to the branch; the `.git` check lets it move.
    host.begin(branch);
    // Reassigned when a pause closes the sandbox and the resume opens another on the same branch.
    let sandbox = await timed(issue.id, "setup", () =>
      open(branch),
      requeuedAs.get(issue.id),
      undefined,
      at?.resolveWaitMs,
    ).catch(async (error) => {
      await host.settle(branch, `after ${ref(issue.id)}`).catch(() => {});
      throw error;
    });

    // Every agent pass goes through here: its readable log is tidied once the pass has returned, or thrown.
    // Its anonymous memory is sampled while it runs, for the agent's figure on the peaks line (src/peaks.ts).
    // Its `<followup>` lines are read here too, so no pass - a narrow review, a repair - can leave one unread.
    // A pass that hits the plan's usage limit, with `USAGE_PAUSE` set, does not end the ticket: the run pauses
    // until the window resets, this ticket parks like any other at a juncture (sandbox closed, branch kept), and
    // the same pass runs again in a fresh sandbox after the resume. Its time parked is `waitMs` of the step.
    let agentsRan = false;
    const pass = async (opts: Parameters<typeof sandbox.run>[0]) => {
      agentsRan = true;
      const phase = phaseOf(opts.name ?? "");
      const parkedBefore = parkedInStep;
      for (;;) {
        const logFrom = logSize(opts.logging);
        if (opts.logging?.type === "file" && typeof opts.logging.path === "string") passStarts.set(basename(opts.logging.path), logFrom);
        try {
          const r = await sampling(sandbox, "agent", () => sandbox.run(opts))
            .then((r) => {
              for (const f of followUpsOf(r.stdout ?? "")) ctx.followUps?.push({ ...f, from: issue.id, phase });
              return r;
            })
            .finally(() => opts.logging && "path" in opts.logging && relabelContextWindow(opts.logging.path));
          return parkedInStep > parkedBefore ? Object.assign(r, { waitMs: parkedInStep - parkedBefore }) : r;
        } catch (error) {
          // The cross-review is a second opinion that never stopped a run, so its limit is not waited out either.
          // Without a juncture there is nothing to park at, and a pass run again at once would only fail again.
          const parks = parkCount;
          const pausing = at && ctx.limitPause && phase !== "cross-review" && passHitLimit(opts.logging, logFrom) && ctx.limitPause(phase);
          if (pausing) {
            console.log(`${ref(issue.id)}: the ${phase} pass hit the plan's usage limit - the run pauses until the window resets, and the pass runs again then.`);
            await juncture(phase as TicketState, true);
            if (parkCount !== parks) {
              run.ticket(issue.id, { state: phase as TicketState, note: "running the pass again after the plan's usage window reset" });
              continue;
            }
          }
          // The time parked before the error is no work of the ticket's either.
          if (parkedInStep > parkedBefore) waited.set(issue.id, (waited.get(issue.id) ?? 0) + parkedInStep - parkedBefore);
          throw error;
        }
      }
    };

    // A paused run starts no agent pass: before each one the ticket asks the scheduler's juncture, which
    // returns at once unless a person has paused the run. Then the sandbox closes - every commit stays on the
    // branch, and Sandcastle keeps a worktree that holds uncommitted files, which is locked against a prune
    // meanwhile - and the ticket waits holding nothing (the attempt gives its slot back). On the resume a
    // fresh sandbox opens on the same branch and the pass begins from there, so the phases already done are
    // not repeated. It is called before the pass's `timed` step: the wait is not the pass's time, nor part of
    // the ticket's usual one (`waited`, as a wait for a gates slot is).
    let parkedAt = 0;
    // The sandbox was closed at a juncture and the run stopped before the resume reopened one: nothing is left to close.
    let closedWhileParked = false;
    // How often the ticket has parked: a juncture that returns with it unchanged did not park, as a run that is not paused.
    let parkCount = 0;
    // The time parked from inside an agent pass (the plan's limit), which the pass reports as the `waitMs` of its step.
    let parkedInStep = 0;
    const juncture = (phase: TicketState, inPass = false) =>
      at?.juncture(phase, {
        suspend: async () => {
          const head = sh("git", ["rev-parse", "--short", branch], project.root);
          console.log(`${ref(issue.id)}: paused before ${phase} - its sandbox closes, ${branch} stays at ${head}`);
          run.ticket(issue.id, { state: "paused", note: `before ${phase} at ${head}` });
          unlockWorktree(sandbox.worktreePath, project.root);
          await recordPeak(sandbox, project.root, runId);
          const closed = await sandbox.close();
          if (closed.preservedWorktreePath) lockWorktree(closed.preservedWorktreePath, project.root);
          parkedAt = Date.now();
          parkCount++;
          closedWhileParked = true;
        },
        resume: async () => {
          const parked = Date.now() - parkedAt;
          if (inPass) parkedInStep += parked;
          else waited.set(issue.id, (waited.get(issue.id) ?? 0) + parked);
          releaseBranchWorktree(branch, project.root);
          sandbox = await timed(issue.id, "setup", () => open(branch), `resumed before ${phase}`);
          lockWorktree(sandbox.worktreePath, project.root);
          closedWhileParked = false;
        },
      });

    try {
      // Normally already locked by the worktree hook; this covers a worktree
      // Sandcastle reused.
      lockWorktree(sandbox.worktreePath, project.root);
      // A branch that no longer merges onto the base ends its pipeline at once: no review or gate run is spent on it,
      // and the scheduler sends it back to resolve the merge (the requeue-once rule). Never a green, which would tell
      // landing that the gates vouched for a commit they never ran on.
      const conflicted = (before: "review" | "gates", o: Pick<Outcome, "reviewCommits" | "repairs" | "idleRepairs" | "carried">): Outcome | undefined => {
        const conflict = conflictBefore(branch);
        if (!conflict) return undefined;
        console.log(`${ref(issue.id)}: ${branch} no longer merges onto ${base} (${conflictLine(conflict)}) - its ${before === "review" ? "review and gates are" : "gates are"} skipped.`);
        return { issue: issue.id, branch, status: "conflict", conflict, commits: ownCommits(base, branch, project.root), gates: [], head: sh("git", ["rev-parse", branch], project.root), ...o };
      };
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
      const carried = Number(sh("git", ["rev-list", "--count", `${base}..${branch}`], project.root)) > 0;
      // The requeue-once state holds the first attempt's line only on a second attempt in this run.
      const requeued = requeuedAs.has(issue.id);
      // The repair passes of the first attempt, so the outcome line counts the ticket's whole run: `repairs` below bounds one attempt's loop only.
      const earlierRepairs = requeued ? firstAttemptRepairs(results, issue.id) : 0;
      const earlierIdle = requeued ? firstAttemptIdleRepairs(results, issue.id) : 0;
      const behind = Number(sh("git", ["rev-list", "--count", `${branch}..${base}`], project.root));
      // Read before the base merge, which moves the tip. A branch at the head it
      // was reviewed and gated green on, or past it by merge commits only, needs no
      // implement or full review: only the merge and the gates stand between it and landing.
      const greenOnly = carried ? landOnlyHead(project.root, base, issue.id) : undefined;
      // A branch reviewed but never green (stopped while its gates ran) needs no implementer either:
      // the gates have not said it is wrong. A red result is the record's `red`, which this refuses.
      const reviewedOnly = carried && greenOnly === undefined ? reviewedOnlyHead(project.root, base, issue.id) : undefined;
      const greenHead = greenOnly ?? reviewedOnly;
      let landOnly = greenHead !== undefined;
      // A tip past the head is merge commits only (landOnlyHead): a resolution a hold left
      // on the branch was never reviewed, unless a narrow review has since recorded the tip.
      const carriedMerge = greenHead !== undefined && sh("git", ["rev-parse", branch], project.root) !== greenHead && readHeads(project.root)[issue.id]?.reviewed !== sh("git", ["rev-parse", branch], project.root);
      if (greenHead !== undefined) {
        console.log((reviewedOnly !== undefined ? reviewedCarriedLine : greenCarriedLine)(ref(issue.id), greenHead, requeued));
        run.ticket(issue.id, { note: "land only - reviewed earlier" });
      }
      let mergeConflicted = false;
      // The base commit the merge below joined, for checking the resolution against git's own
      // merge. Read from the merge itself: the landing worker can move the base between a host
      // rev-parse and the merge, and the newly landed lines would then read as strays.
      let baseTip: string | undefined;
      // A clean merge of the base into the branch: what the requeue compares with its landing gate's red (`repairFromRed`).
      let joined: { merge: string; head: string; base: string } | undefined;
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
              `${ref(issue.id)}: ${carriedBranch(landOnly, requeued, reviewedOnly !== undefined)} conflicts with ${base} in generated files (${files.join(", ")}), and regenerating failed (${r.reason}); ${landOnly ? "a resolver resolves the merge, then the gates run" : "the implementer resolves the merge"}.`,
            );
          }
        } else if (pull.exitCode === 0) {
          console.log(carriedMergeLine(ref(issue.id), base, behind, requeued));
          // The merge commit and the two commits it joined, read in the sandbox that made it: a base that moved
          // between a host read and the merge is then never mistaken for the tip the landing gate ran on.
          const [merge, head, joinedBase] = (await sandbox.exec("git rev-list --parents -n 1 HEAD")).stdout.trim().split(/\s+/);
          if (joinedBase) joined = { merge, head, base: joinedBase };
        }
        else if (unmerged) {
          mergeConflicted = true;
          console.log(
            landOnly
              ? `${ref(issue.id)}: ${carriedBranch(true, requeued, reviewedOnly !== undefined)} conflicts with ${base} (${files.join(", ")}); a resolver resolves the merge, then the gates run.`
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
            sh("git", ["merge-base", "--is-ancestor", tip, `refs/heads/${base}`], project.root);
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
        await juncture("resolve");
        await timed(issue.id, "resolve", () => {
          const logging = agentLogging(project, issue.id, `resolve-${issue.id}`, runId);
          return pass({
            name: `resolve-${issue.id}`,
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
          if (hitLimit(project.root, issue.id)) throw error;
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
        const stray = strayChanges(project.root, { ours: greenHead, theirs: baseTip, resolved: sh("git", ["rev-parse", branch], project.root), generated: project.generated });
        if (stray?.length) {
          const why = strayNote(stray);
          // No `files` on the record: the report reads them as a protected-path hold ("changes X") and would hide this note.
          console.log(`${ref(issue.id)}: the ${why} - held for a human.`);
          notes.push({ issue: issue.id, kind: "hold", text: `Sandcastle held this: ${why}.` });
          // `held` from the first write: the kit held a finished, green resolution, the agent handed nothing back.
          return heldResolution(issue.id, branch, why, {
            commits: ownCommits(base, branch, project.root),
            reviewCommits: requeued ? firstAttemptReviewCommits(results, issue.id) : 0,
            repairs: earlierRepairs,
            idleRepairs: earlierIdle,
            gates: readHeads(project.root)[issue.id]?.gates ?? [],
          });
        }
      }
      // Review passes run on the same warm sandbox and branch. Their commits
      // ride the same gates as the implementer's, so a review that breaks the
      // build cannot merge either. Log names keep `-review-` for status.sh.
      const reviewRun = (name: string, promptFile = prompts.review, args: Record<string, string> = promptArgs) => (agent: Parameters<typeof sandbox.run>[0]["agent"]) =>
        pass({
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
      const narrowReview = async (since: string, note: string) => {
        await juncture("review");
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
      // A land-only re-run keeps the first attempt's review commits on its branch: `commits` counts them, so `reviewCommits` does.
      let reviewCommits = landOnly && requeued ? firstAttemptReviewCommits(results, issue.id) : 0;
      // A pass's own commits, counted as `commits` is (no merges): a pass's commit list includes the
      // base commits its merge brought in, which read as `commits=1 (review=14)`.
      const ownNow = () => ownCommits(base, branch, project.root);
      // What reviewers said no gate exercises; read whether or not the tracker lets agents write.
      const ungated: string[] = [];
      // What reviewers said of a gap in prose and filed nowhere (`gapOf`).
      const gaps: string[] = [];
      // The lines of every agent's final message, only when the project asked for them. A land-only
      // branch runs no implementer or review: its lines stand from its head record, as `unmet` does.
      const changelog: string[] = landOnly ? [...(readHeads(project.root)[issue.id]?.changelog ?? [])] : [];
      let changelogDropped = landOnly ? (readHeads(project.root)[issue.id]?.changelogDropped ?? 0) : 0;
      // The implementer's lines come first; a later full review that gives lines restates the branch's whole
      // set and replaces them, a narrow pass adds its own (see addChangelog).
      const noteChangelog = (text: string | undefined, narrow = false) => {
        if (!project.changelog || !text) return;
        changelogDropped += addChangelog(changelog, text, narrow);
      };
      // What the agents knowingly left undone. The implementer's word stands only until a full
      // review has read the branch after it: the reviewer may have finished the criterion.
      // A land-only branch runs no implementer or review: what its agents said stands from its head record.
      let implUnmet = landOnly ? readHeads(project.root)[issue.id]?.unmet : undefined;
      let reviewed = false;
      const unmet: string[] = [];
      // What the agents have said so far, as a head record keeps it: a branch stopped mid-gates is re-run
      // from its reviewed tip with no agent, and without this its criteria and changelog lines would be gone.
      const agentsSaid = () => {
        const left = reviewed ? unmet : [...(implUnmet ? [implUnmet] : []), ...unmet];
        return {
          unmet: left.length ? cutAtWord([...new Set(left)].join("; "), UNGATED_MAX) : undefined,
          changelog: changelog.length ? [...new Set(changelog)] : undefined,
          changelogDropped: changelogDropped || undefined,
        };
      };
      if (landOnly && (mergeConflicted || carriedMerge) && greenHead !== undefined) {
        // The resolver finished the merge on a branch reviewed and green at greenHead, or the branch
        // carries a merge from an earlier run that no review has read: nobody has seen its
        // resolution. A clean land-only merge of the base needs no review.
        console.log(`${ref(issue.id)}: ${mergeConflicted ? "conflict resolved" : "merge carried from an earlier run"} - reviewing the resolution only.`);
        const beforeResolved = ownNow();
        const resolved = await narrowReview(greenHead, "after conflict resolution");
        noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch], project.root) });
        reviewCommits += ownNow() - beforeResolved;
        noteChangelog(resolved.stdout, true);
        const said = tracker.agentsWrite ? undefined : tags(resolved.stdout).report;
        if (said) addReport(issue.id, "Reviewer (after conflict resolution)", said);
        const u = unmetOf(resolved.stdout);
        if (u) unmet.push(u);
        noteHead(issue.id, branch, agentsSaid());
      }
      if (!landOnly) {
        await juncture("implement");
        const impl = await timed(issue.id, "implement", () => {
          const logging = agentLogging(project, issue.id, `impl-${issue.id}`, runId);
          return pass({
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
            return { issue: issue.id, branch, status: "nochange", commits: 0, reviewCommits: 0, repairs: earlierRepairs, idleRepairs: earlierIdle, gates: [] };
          }
          if (report) addReport(issue.id, "Implementer", report);
        }
        noteChangelog(impl.stdout);
        implUnmet = unmetOf(impl.stdout);

        // `impl.commits` counts what THIS run added, which is zero in two very
        // different cases: the agent found nothing to do, and the agent found the
        // work already done on the branch from an earlier run. Only the first is
        // `nochange`. How far the branch is ahead of the base tells them apart -
        // without it, a branch whose review died could never be reviewed by
        // re-running the issue: it came straight back as `nochange` with the work
        // still standing, unreviewed and unmerged.
        const branchCommits = Number(sh("git", ["rev-list", "--count", `${base}..${branch}`], project.root));
        if (impl.commits.length === 0 && branchCommits === 0) {
          // Nothing lands for a nochange, so nothing else would carry the report.
          return { issue: issue.id, branch, status: "nochange", commits: 0, reviewCommits: 0, repairs: earlierRepairs, idleRepairs: earlierIdle, gates: [] };
        }

        const beforeReview = conflicted("review", { reviewCommits: 0, repairs: earlierRepairs, idleRepairs: earlierIdle, carried });
        if (beforeReview) return beforeReview;

        // Only a base merge since the last completed review: review the merge, not the branch.
        const since = narrowReviewBase(project.root, base, issue.id);
        if (since !== undefined && since === sh("git", ["rev-parse", branch], project.root)) {
          console.log(`${ref(issue.id)}: nothing new since its review at ${since.slice(0, 7)} - no review; the gates decide.`);
        } else if (since !== undefined) {
          console.log(`${ref(issue.id)}: only a base merge since its review at ${since.slice(0, 7)} - reviewing the merge only.`);
          const beforeMerged = ownNow();
          const merged = await narrowReview(since, "after base merge");
          noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch], project.root) });
          reviewCommits = ownNow() - beforeMerged;
          noteChangelog(merged.stdout, true);
          const said = tracker.agentsWrite ? undefined : tags(merged.stdout).report;
          if (said) addReport(issue.id, "Reviewer (after base merge)", said);
          const u = unmetOf(merged.stdout);
          if (u) unmet.push(u);
          noteHead(issue.id, branch, agentsSaid());
        } else {
          await juncture("review");
          let reviewModel: string | undefined;
          const beforeReview = ownNow();
          const review = await timed(
            issue.id,
            "review",
            () => {
              return reviewWithFallback(ref(issue.id), (agent, model) => {
                reviewModel = model;
                return reviewRun(`review-${issue.id}`, prompts.review, { ...promptArgs, IMPL_UNMET: implUnmetView(implUnmet), IMPL_CHANGELOG: implChangelogView(changelog) })(agent);
              });
            },
            undefined,
            () => reviewModel,
          );
          if (CROSS_REVIEW) await juncture("cross-review");
          const cross = CROSS_REVIEW
            ? await timed(
                issue.id,
                "cross-review",
                () => {
                  return crossReview(ref(issue.id), reviewRun(`review-codex-${issue.id}`, prompts.review, { ...promptArgs, IMPL_UNMET: implUnmetView(implUnmet), IMPL_CHANGELOG: implChangelogView(changelog) }));
                },
                undefined,
                () => CROSS_REVIEW_MODEL,
              )
            : undefined;
          noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch], project.root) });
          reviewCommits = ownNow() - beforeReview;
          reviewed = true;
          for (const r of [review, cross]) {
            const u = r && ungatedOf(r.stdout);
            if (u) ungated.push(u);
            const g = r && gapOf(r.stdout);
            if (g) gaps.push(g);
            noteChangelog(r?.stdout);
            const m = r && unmetOf(r.stdout);
            if (m) unmet.push(m);
          }
          noteHead(issue.id, branch, agentsSaid());
          if (!tracker.agentsWrite) {
            for (const [who, r] of [["Reviewer", review], ["Cross-reviewer", cross]] as const) {
              const said = r && tags(r.stdout).report;
              if (said) addReport(issue.id, who, said);
            }
          }
        }
      }

      // What the agents needed before any gate: `memory.peak` cannot be reset, so after a gate it is the gate's.
      // A land-only re-run gives one only when a narrow review ran in this sandbox (after a resolve, or for a carried merge).
      if (agentsRan) await agentBaseline(sandbox);

      const beforeGates = conflicted("gates", { reviewCommits, repairs: earlierRepairs, idleRepairs: earlierIdle, carried });
      if (beforeGates) return beforeGates;

      // Gates are checked here, in the orchestrator. No agent gets to tell us
      // they passed - `exitCode` is returned rather than thrown.
      // A requeue after a red landing gate, on a base that has not moved and a branch no agent has touched since
      // the merge: that merge is the tree the landing gate ran, so a gate run would return the same red, and the
      // repair starts from the landing gate's own output.
      const redAtLanding = requeued && joined && sh("git", ["rev-parse", branch], project.root) === joined.merge ? repairFromRed(reds.get(issue.id), joined) : undefined;
      reds.delete(issue.id);
      let gated: GateRun;
      if (redAtLanding) {
        console.log(`${ref(issue.id)}: ${base} has not moved since ${redAtLanding.failure.name} went red at landing - no gate run; the repair starts from that output.`);
        gated = { gates: redAtLanding.gates, failure: redAtLanding.failure, failures: [redAtLanding.failure] };
      } else gated = await timed(issue.id, "gates", () => gate(sandbox, issue.id));
      // Recorded now, not at the end: a run stopped during the repair that follows would otherwise leave
      // the tip looking reviewed with no gate result, and a re-run would only gate it again.
      if (gated.failure) noteHead(issue.id, branch, { red: sh("git", ["rev-parse", branch], project.root) });
      // The forced red is named as such everywhere it shows: "ruff red" for a
      // gate that passed sent a reader looking for a ruff failure.
      let forced = false;
      if (testRedGate && !gated.failure) {
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
      const attempts = repair;
      let preRepair = sh("git", ["rev-parse", branch], project.root);
      const seen = new Set<string>();
      // The failures this ticket has already waited a fix for: a second wait on one would never end the loop's own repair.
      const waitedFor = new Set<string>();
      let repairs = 0;
      // Passes that left the branch where it was: the repairer judged the red a flake, or could do nothing.
      let idle = 0;
      for (
        let red = gated.failure;
        red && red.exitCode !== 124 && attempts > 0 && repairs < attempts + 2 && (repairs < attempts || !seen.has(failureKey(red)));
        red = gated.failure
      ) {
        const failure = red;
        const onBase = await redOnBase(failure, branch);
        if (onBase) {
          const fresh = onBase.filter((t) => !toldRed.has(t));
          for (const t of fresh) {
            toldRed.add(t);
            console.log(`base went red mid-run: ${t}`);
          }
          if (fresh.length) baseWentRed(fresh);
          break;
        }
        const key = failureKey(failure);
        // Before the fix board is consulted: a ticket parked here claims nothing, so no other ticket waits for its fix through the pause.
        await juncture("repair");
        // Another ticket is already repairing this failure: its landing is the fix, so wait for it, merge
        // the new base and gate again. A forced red is the same text on every ticket and waits for none.
        const asked = forced || waitedFor.has(key) ? undefined : fixes.fixing(key, issue.id);
        // A fix whose landing this branch already holds (it started after) is no news: merging the moved base
        // would gate the same failure again, one gate run for nothing. The red is this ticket's own. A landing
        // with no commit on record, or one git cannot place, is not known to be in the branch: it merges as before.
        const fixing = asked?.landed && asked.commit && isAncestor(project.root, asked.commit, branch) ? undefined : asked;
        if (fixing) {
          const fixer = fixing.by;
          waitedFor.add(key);
          // A fix already on the base is merged without a wait, so no note: it would stay on the ticket's card.
          if (!fixing.landed) {
            const tests = failingTests(failure.output);
            const line = `waiting for ${ref(fixer)}'s fix to ${tests.length ? tests.join(", ") : `the ${failure.name} gate`}`;
            console.log(`${ref(issue.id)}: ${line}`);
            run.ticket(issue.id, { note: line });
          }
          // Not landed (it failed, gave up or was held): nothing to wait for, the repair is this ticket's own.
          // The wait is another ticket's work, like a slot wait: in its usual time, it would inflate every later estimate.
          const asked = Date.now();
          const fixLanded = await fixes.wait(issue.id, fixer, at?.paused);
          waited.set(issue.id, (waited.get(issue.id) ?? 0) + Date.now() - asked);
          // The wait ended because the run is paused, and the fixer may be parked and unable to land until the
          // resume: this ticket parks too (the loop's juncture, above, closes its sandbox and gives its slot back),
          // then asks the board again - the fixer may have landed meanwhile, and the fix is merged as usual.
          if (!fixLanded && at?.paused?.()) {
            waitedFor.delete(key);
            continue;
          }
          if (fixLanded) {
            // A merge that conflicts is left for the repair, as the carried branch's is at landing.
            const before = (await sandbox.exec("git rev-parse HEAD")).stdout.trim();
            const pull = await sandbox.exec(`git ${hostIdentity(project.root)} merge --no-edit ${shq(base)}`);
            if (pull.exitCode !== 0) await sandbox.exec("git merge --abort");
            else if ((await sandbox.exec("git rev-parse HEAD")).stdout.trim() !== before) {
              console.log(`${ref(issue.id)}: ${ref(fixer)} landed - merged ${base} into its branch, gating again`);
              // The merge is the base's lines, not repair commits: the review after a repair reads from here,
              // unless this ticket repaired before it waited - those commits still get their review.
              if (!repairs) preRepair = sh("git", ["rev-parse", branch], project.root);
              gated = await timed(issue.id, "gates", () => gate(sandbox, issue.id));
              continue;
            }
          }
        }
        seen.add(key);
        if (!forced) fixes.claim(key, issue.id);
        repairs++;
        const why = forced ? "test red gate" : `${failure.name} red`;
        console.log(
          `${ref(issue.id)}: ${forced ? `test red gate (SANDCASTLE_TEST_RED_GATE; ${failure.name} passed)` : why} - repair pass ${repairs}`,
        );
        forced = false;
        const beforePass = sh("git", ["rev-parse", branch], project.root);
        // A repair that dies (idle timeout, agent exit) leaves the branch red,
        // not the issue crashed: the gate results stay in the report. A spent
        // allowance still has to stop the queue, so that one is rethrown.
        const fixed = await timed(issue.id, "repair", () => {
          const logging = agentLogging(project, issue.id, `repair-${issue.id}`, runId);
          return pass({
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
            if (hitLimit(project.root, issue.id)) throw error;
            console.log(`${ref(issue.id)}: repair pass failed (${String(error).slice(0, 120)}); leaving the branch red.`);
            return false;
          },
        );
        if (sh("git", ["rev-parse", branch], project.root) === beforePass) idle++;
        if (!fixed) break;
        gated = await timed(issue.id, "gates", () => gate(sandbox, issue.id));
      }
      // Remembered across attempts and runs: a repair fixes what the gate named, often a file the ticket's
      // `Touches:` line has no reason to list, so landing leaves what only these commits changed out of its overrun.
      if (repairs) {
        const earlier = readHeads(project.root)[issue.id];
        const made = sh("git", ["rev-list", "--no-merges", `${preRepair}..${branch}`], project.root).split("\n").filter(Boolean);
        if (made.length) noteHead(issue.id, branch, { repaired: [...new Set([...(earlier?.branch === branch ? (earlier.repaired ?? []) : []), ...made])] });
      }

      // A repair works against a red gate, and the easy way to green is to
      // weaken the test - which the gate then passes. The prompt forbids it,
      // but a rule is not a check: a green branch whose repair committed gets
      // the review pass again, on the repair commits. Its own commits are
      // gated once more; a red there is final, with no second repair loop.
      let unreviewed = false;
      if (!gated.failure && sh("git", ["rev-parse", branch], project.root) !== preRepair) {
        // A review that dies leaves the branch held, not the ticket crashed:
        // like a failed repair, only a spent allowance stops the queue.
        await juncture("review");
        let afterModel: string | undefined;
        const beforeAfter = ownNow();
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
          if (hitLimit(project.root, issue.id)) throw error;
          console.log(`${ref(issue.id)}: the review after repair failed (${String(error).slice(0, 120)}); holding the branch for a human.`);
          unreviewed = true;
          return undefined;
        });
        if (after) {
          noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch], project.root) });
          reviewCommits += ownNow() - beforeAfter;
          const u = ungatedOf(after.stdout);
          if (u) ungated.push(u);
          const g = gapOf(after.stdout);
          if (g) gaps.push(g);
          noteChangelog(after.stdout, true);
          const m = unmetOf(after.stdout);
          if (m) unmet.push(m);
          noteHead(issue.id, branch, agentsSaid());
          const said = tracker.agentsWrite ? undefined : tags(after.stdout).report;
          if (said) addReport(issue.id, "Reviewer (after repair)", said);
          if (after.commits.length) gated = await timed(issue.id, "gates", () => gate(sandbox, issue.id));
        }
      }

      const head = sh("git", ["rev-parse", branch], project.root);
      const { unmet: unmetNote, changelog: changelogNote } = agentsSaid();
      // `unmet` written even when undefined, so a green head with every criterion met drops an earlier one.
      if (!gated.failure && !unreviewed) noteHead(issue.id, branch, { green: head, red: undefined, unmet: unmetNote, gates: gated.gates, changelog: changelogNote, changelogDropped: changelogDropped || undefined });
      // A red result is told apart from a stop mid-gates, which records none: only the second re-runs from its review.
      else if (gated.failure) noteHead(issue.id, branch, { red: head });
      return {
        issue: issue.id,
        branch,
        status: gated.failure ? "gate-failed" : "green",
        // Branch total, so a re-run of an already-implemented branch does not
        // report 0 commits while shipping its work. Without the kit's base merge-ins.
        commits: ownCommits(base, branch, project.root),
        reviewCommits,
        repairs: earlierRepairs + repairs - idle,
        idleRepairs: earlierIdle + idle,
        gates: gated.gates,
        failing: gated.failure ? failingTests(gated.failure.output) : undefined,
        head,
        carried,
        unreviewed,
        ungated: ungated.length ? cutAtWord([...new Set(ungated)].join("; "), UNGATED_MAX) : undefined,
        gap: gaps.length ? cutAtWord([...new Set(gaps)].join(" "), UNGATED_MAX) : undefined,
        changelog: changelogNote,
        changelogDropped: changelogDropped || undefined,
        unmet: unmetNote,
      };
    } finally {
      // Added up: a requeued ticket's second pipeline is more time on it, not a replacement.
      took.set(issue.id, (took.get(issue.id) ?? 0) + Date.now() - started);
      // A ticket parked by a pause when the run stopped closed its sandbox at the juncture, and keeps its lock like a
      // ticket whose run was killed while paused: the next run's resume releases it.
      if (!closedWhileParked) {
        unlockWorktree(sandbox.worktreePath, project.root);
        // The sandbox's peak memory, for `sandcastle size`: last read before it closes.
        await recordPeak(sandbox, project.root, runId);
        // Sandcastle keeps a worktree with uncommitted files rather than lose
        // them. Say so, or it lingers unexplained in .sandcastle/worktrees/.
        const closed = await sandbox.close();
        if (closed.preservedWorktreePath) keptWorktrees.push({ issue: issue.id, path: closed.preservedWorktreePath });
      }
      // A failed check stops the run; the pipeline keeps its own result, or its own error.
      await settleAfter(
        () => host.settle(branch, `after ${ref(issue.id)}`),
        (error) => tampered.set(issue.id, error),
      );
    }
  };
};

let unlockOnExit = false;

/**
 * False when the queue was empty or all of it waiting: nothing ran, so there is no turn to follow.
 * `turn.docker` is the start's one `docker info` reading, which the first turn takes over from the
 * runtime check (cli.ts); a turn handed none reads its own.
 */
export const burndown = async (project: Project, turn?: { settings: ResolvedSettings; turn: number; docker?: () => string | undefined }): Promise<boolean> => {
  const DRY_RUN = process.env.DRY_RUN === "1";
  // A test of the repair path itself. An agent that can read a gate makes it
  // pass before it exits, so a live run almost never reaches a repair; this
  // counts each ticket's first gate run as red, with an output that says so.
  // Off without repair passes: a forced red nobody repairs would only hold
  // good work back.
  // The turn's own settings, so the record it writes and what the run does cannot differ.
  const settings = turn?.settings ?? resolveSettings({ env: process.env, project, machine: machineSettings() });
  const TEST_RED_GATE = process.env.SANDCASTLE_TEST_RED_GATE === "1" && settings.repair > 0;
  // Four by default, not one-per-issue. Twelve at once saturated a 15-core
  // machine to load 33 and starved a vitest run into a false gate failure -
  // good work withheld by resource contention rather than by a defect.
  const CONCURRENCY = settings.concurrency.asked;
  const base = project.baseBranch;

  // Fail before spending a single container.
  const notify = notifyCommand();
  disableHostGitHooks();
  disableHostGitGc();
  pinHostGitConfig(project.root);
  assertCleanBase(project);
  lockRun(project);
  reapOrphans(project);
  // A held branch merged or deleted by hand leaves its backup entry behind: only a landing drops one.
  const swept = pruneBackup(project);
  if (swept.length) console.log(`Dropped the backup of ${swept.length} branch(es) that no longer need one: ${swept.join(", ")}.`);

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
  const sharesLog = join(project.root, ".sandcastle/logs/file-shares.log");
  let sharesHeaded = false;
  const holds = createHoldRecord({
    waiting,
    ref,
    say: (line) => console.log(line),
    log: (line) => {
      mkdirSync(dirname(sharesLog), { recursive: true });
      // The log is appended to across runs: without a header no pair could be told from another turn's.
      if (!sharesHeaded) appendFileSync(sharesLog, `--- ${new Date().toISOString()}, run pid ${process.pid} ---\n`);
      sharesHeaded = true;
      appendFileSync(sharesLog, `${line}\n`);
    },
  });
  const candidates = schedule.start.map((c) => c.ticket);
  const issues = schedule.start.flatMap((c) => (c.wait ? [] : [c.ticket]));
  const dependants = schedule.start.flatMap((c) => (c.wait === "blockers" ? [c.ticket] : []));
  const parked = schedule.start.flatMap((c) => (c.file ? [{ ticket: c.ticket, wait: c.file }] : []));
  // `order` in run.json: the place in the start list; a released or requeued ticket is given an earlier one when it is (`createHoldRecord`).
  const order = new Map(candidates.map((t, at) => [t.id, at] as const));
  // `inRun`: tickets whose plan line already names their blockers; a line of their own here said it twice.
  const sayWaits = (inRun = new Set<string>()) => {
    for (const w of waiting) if (!inRun.has(w.issue)) console.log(`  ${ref(w.issue)} waits for ${w.on.join(", ")} to close`);
  };
  if (issues.length === 0) {
    sayWaits();
    holds.start(schedule.start);
    console.log("Every queued ticket is waiting on another. Nothing to start.");
    return false;
  }
  const overrides = new Map([...issues.map((i) => [i.id, ticketOverride(ref(i.id), i.labels ?? [])] as const), ...laterOverrides]);
  // Resolved once here: the image, the start lines and run.json all name the same versions.
  const versions = await resolveVersions(project);

  // A dry run lands nothing, so it needs no sandbox slot for it.
  const workers = pipelineWorkers(CONCURRENCY, candidates.length, limit("sandboxes"), !DRY_RUN);
  const capped = workers < Math.min(CONCURRENCY, candidates.length);
  // "up to": another project's live run can cut this run's share below it, which the split line under the
  // ticket list and the estimate give; a bare "2 at a time" above "this run's share is 1" read as two stories.
  console.log(
    `${candidates.length} ticket(s)${dependants.length ? ` (${dependants.length} start as their blockers land)` : ""}${parked.length ? ` (${parked.length} wait for a file git cannot merge)` : ""}, up to ${workers} at a time${DRY_RUN ? " [DRY RUN]" : ""} - ${MODELS_LINE}:` +
      (capped ? ` (CONCURRENCY=${CONCURRENCY}, but ${landingSlotNote(limit("sandboxes"))})` : ""),
  );
  for (const i of candidates) {
    const o = overrides.get(i.id) ?? {};
    const own = implementNote(o);
    const later = parked.find((p) => p.ticket.id === i.id);
    const blockers = waiting.find((w) => w.issue === i.id)?.on.join(", ") || "a blocker";
    console.log(`  ${ref(i.id)} ${i.title}${own}${dependants.includes(i) ? ` - waits for ${blockers} in this run` : later ? ` - ${fileWaitNote(ref, later.wait)}` : ""}`);
  }
  // A Touches line naming a path the kit always holds: the work is still wanted and runs, only its merge is a
  // person's. Said now, since the reason was otherwise news only at the end of the run.
  for (const line of protectedPlanLines(project, candidates, ref)) console.log(`  ${line}`);
  // After the header, with the ticket list and the shared-file lines: they are indented under it.
  sayWaits(new Set(dependants.map((d) => d.id)));
  holds.start(schedule.start);
  // Asked before the run (cli.ts), and said on every turn's start lines too: a run that bills API credits is never silent.
  const spend = projectApiKeySpend(project);
  if (spend) console.log(red(runApiKeyLine(spend)));
  console.log(versionsLine(versions));
  // Before any sandbox: every one this turn opens takes a CPU limit by its kind, so agents' own full-suite
  // runs cannot crowd out each other and the gates beside them, nor starve the landing, base and verify
  // gates, which run one at a time and set the run's end (`gateProject` below opens those).
  // One `docker info` for both this and the pool warning below; on Linux docker not answering stops the run here, before anything is recorded or started.
  const info = turnDockerInfo(turn?.docker ?? readDockerInfo);
  const pool = { concurrency: settings.concurrency.effective, maxGates: limit("gates") };
  const ticketCpus = sandboxCpus(project, "ticket", pool, () => info);
  const gateCpus = sandboxCpus(project, "gate", pool, () => info);
  console.log(cpusLine(project, ticketCpus, gateCpus));
  // The project as the gate-only sandboxes see it; `project` from here is a ticket's.
  const gateProject = { ...project, cpus: gateCpus };
  project = { ...project, cpus: ticketCpus };
  // The measured anonymous memory says the pool is larger than the VM fits: said here, where the run's cost is read, and not only in doctor.
  for (const line of poolWarningsNow(() => info)) console.log(`warning: ${line}`);
  // Another live run shares the pool: say how it is split, before the estimate that divides by this run's share.
  const others = otherRuns();
  const split = others.length ? splitAtStart(workers, others) : undefined;
  for (const line of startLines(split ?? { share: workers, free: limit("sandboxes") }, others.map((m) => {
    const found = recordOfRun(m.pid);
    const name = m.project || found?.record.orchestrator;
    return { project: name, registered: m.registered, held: m.held, demand: m.demand, wait: found && name ? firstSlotWait({ root: found.root, name } as Project, found.record) : undefined };
  }))) console.log(line);
  // Carried branches, read before any agent touches them: dearer than fresh tickets, so the estimate and the timings say so.
  const carriedAtStart = new Set(candidates.filter((i) => isCarried(project.root, project.baseBranch, i.id)).map((i) => i.id));
  // Sandboxes at once: the estimate's divisor, and the status view's guess at when landing starts.
  const slots = estimateSlots(workers, split);
  const chainIds = blockerChain(project, tracker, candidates);
  const rough = estimate(
    project, candidates.length, slots, chainIds.length,
    candidates.map((i) => overrides.get(i.id)?.model ?? IMPL_MODEL),
    { gateSlots: limit("gates"), carried: candidates.map((i) => carriedAtStart.has(i.id)), chainAt: chainIds.flatMap((id) => { const at = candidates.findIndex((c) => c.id === id); return at < 0 ? [] : [at]; }) },
  );
  if (rough) console.log(rough);
  console.log(`Machine-wide: ${usage()}`);
  console.log(`Keep awake: ${await keepAwake()}`);
  console.log(baseIsTheRunsLine(project.baseBranch));
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
    // `order` too: the place it has until it is released.
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
    load: { concurrency: slots, tickets: candidates.length },
    ...(turn ? { settings: settingsGroup(turn.settings, turn.turn, usageReadingLost()) } : {}),
    typical: typicalTimes(project),
    tickets: Object.fromEntries(startTickets),
  }, notify && ((r) => runNotify(notify, project.name, r)));
  // The machine-wide list of live runs (the Herdr tab bar, the Claude Code mod), Herdr or not.
  registerRun(project.root);
  // And the machine pool's: the live runs split its sandbox slots by what each one wants. One slot
  // until the scheduler tells its own demand, for the base gates that come first.
  joinPool(project.name, CONCURRENCY, 1);
  // The run record's live values (not settings): what the run wants and its share of the pool now.
  // The share moves as other runs begin and end, so it is read again as well as on a demand change.
  let shown: { demand: number; share: number; cap?: number } = { demand: -1, share: -1 };
  const poolValues = () => {
    // A finished record is the next turn's to replace: a timer writing to it would undo that.
    if (run.finished) return clearInterval(poolWatch);
    const mine = myShare();
    if (!mine || (mine.demand === shown.demand && mine.share === shown.share && mine.cap === shown.cap)) return;
    // `cap` is set by `sandcastle cap` from outside: a lifted one is written as absent, which drops it from the record.
    shown = { demand: mine.demand, share: mine.share, cap: mine.cap };
    run.update(shown);
  };
  const poolWatch: ReturnType<typeof setInterval> = setInterval(poolValues, 5000);
  poolWatch.unref();
  poolValues();
  // Released on any exit, Ctrl-C included, so the clean-up command Sandcastle
  // prints for a kept worktree works as printed.
  // Once per process: each turn of an autonomy run would add another listener.
  if (!unlockOnExit) process.on("exit", unlockAll);
  unlockOnExit = true;
  // Inside Herdr, the run's own tab: the status view and, with `herdr.panes: "all"`, one pane per
  // concurrent sandbox, reporting each one's phase. Otherwise (or with the
  // view off) the status view opens beside the caller. Inside Herdr a run
  // with no status view does not start: nobody would see it.
  const view = openSandboxView(project, workers, ref, run.tickets, sandboxPanes(project), run.usage, run.paused);
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
  // The heartbeat's other tickets in flight: a landing (its step, once it says one) and a sent-back ticket's wait to resolve (since it was told).
  const landing = new Map<string, { phase?: string; since: number }>();
  const resolving = new Map<string, number>();
  const took = new Map<string, number>();
  // Each issue's waits for a gates slot or another's fix, inside `took` but not part of its usual time.
  const waited = new Map<string, number>();
  const spent = new Map<string, Tokens>();
  const keptWorktrees: { issue: string; path: string }[] = [];
  // Each issue's step, and when it started, go to run.json's tickets: the
  // status view cannot tell a gate run from the review before it by the logs
  // alone, and a log's age is how long since its last line, not how long the
  // issue has been at this step.
  const timed = async <T>(issue: string, phase: TicketState | Stage, fn: () => Promise<T> | T, note?: string, model?: () => string | undefined, queuedMs?: number): Promise<T> => {
    const since = Date.now();
    active.set(issue, { phase, since });
    if (issue) {
      if (!isTicketState(phase)) throw new Error(`"${phase}" is a step of the run, not a state of ticket ${issue}`);
      // The record first: the view's workspace count reads it.
      run.ticket(issue, { state: phase, ...firstStart(run.tickets()[issue], phase, since), ...(note ? { note } : {}) });
      view.phase(issue, phase);
    } else run.update({ stage: phase });
    let ok = false;
    let tokens: Tokens | undefined;
    let gateTimes: Record<string, number> | undefined;
    let peakMib: number | undefined;
    let red: string[] | undefined;
    let times: ReturnType<typeof stepTimes> | undefined;
    try {
      const result = await fn();
      times = stepTimes(Date.now() - since, result);
      // Only the wait inside the step is in `took`; the slot wait before it never was (see `withQueued`).
      if (issue && times.waitMs) waited.set(issue, (waited.get(issue) ?? 0) + times.waitMs);
      times = withQueued(times, queuedMs);
      tokens = runTokens(result);
      gateTimes = gateMs(result);
      peakMib = peakOf(result);
      red = gateRed(result);
      // `ok` is pass/fail: a gate run with a red gate is not ok, though it ran.
      ok = !red?.length;
      if (tokens) {
        spent.set(issue, addTokens(spent.get(issue) ?? NO_TOKENS, tokens));
        run.update({ tokens: tokenBrief([...spent.values()].reduce(addTokens, NO_TOKENS)) });
        if (issue) run.ticket(issue, { tokens: tokenBrief(spent.get(issue)!) });
      }
      return result;
    } finally {
      // The pass is over, and its result carries its own figure (in `spent` above, with nothing in between that a
      // tick could interleave with): what its log showed stops counting as live. A pass that threw has none, and nothing of it is kept.
      if (issue) usageWatch?.settle(issue);
      active.delete(issue);
      const m = model?.();
      const line = {
        ts: new Date().toISOString(), run: runId, project: project.name, issue, phase, ...(times ?? withQueued({ ms: Date.now() - since }, queuedMs)), ok,
        ...(carriedAtStart.has(issue) ? { carried: true } : {}),
        ...(m ? { model: m } : {}),
        ...(tokens ? { tokens } : {}),
        ...(gateTimes ? { gates: gateTimes } : {}),
        ...(peakMib ? { peakMib } : {}),
        ...(red?.length ? { red } : {}),
      };
      appendFileSync(timings, JSON.stringify(line) + "\n");
    }
  };

  const image = await timed("", "image", () => ensureImage(project, false, versions));
  // The base the image was built beside: what the merges changed since, in a Dockerfile, is not in the image the verify uses.
  const startTip = sh("git", ["rev-parse", base], project.root);
  const prompts = renderPrompts(project, tracker, DRY_RUN);
  // One entry per distinct override model, naming every ticket that asks for it.
  const extraModels = [...new Set([...overrides.values()].flatMap((o) => (o.model ? [o.model] : [])))].map((model) => {
    const labelled = candidates.filter((i) => overrides.get(i.id)?.model === model).map((i) => ref(i.id));
    return { model, from: `label model:${model} on ${labelled.join(", ")}` };
  });
  await timed("", "preflight", () => preflight(project, image, extraModels));
  const env = credentials(project);
  // The guard's reading is the one settings field a turn may change: it is recorded as a fact beside the setting, when it is lost or back.
  let readingNoted = usageReadingLost();
  const noteReading = () => {
    if (!turn || usageReadingLost() === readingNoted) return;
    readingNoted = usageReadingLost();
    run.update({ settings: settingsGroup(turn.settings, turn.turn, readingNoted) });
  };
  const usageNote = await usageLine(env);
  noteReading();
  if (usageNote) console.log(usageNote);
  archiveFinishedLogs(project);
  // The plan's usage on screen, from the agents' own rate-limit events: one entry per provider the run
  // spends a plan of. Claude's when the run spends a subscription on a Claude model (an API key bills
  // credits no plan describes); Codex's when cross-review runs on a ChatGPT sign-in, not an API key. Until
  // a provider's first reading, its entry says it is waiting for one. After the archive above, which moves
  // finished branches' logs away: the watch reads the logs that are left.
  let usageWatch: UsageWatch | undefined;
  const passModels = [IMPL_MODEL, REVIEW_MODEL, ...[...overrides.values()].flatMap((o) => (o.model ? [o.model] : []))];
  const planUsage: PlanUsage[] = [
    ...(showsPlanUsage({ apiKey: !!spend, oauthToken: !!env.CLAUDE_CODE_OAUTH_TOKEN, models: passModels }) ? [{ provider: "claude" as const }] : []),
    ...(showsCodexUsage({ crossReview: CROSS_REVIEW, apiKey: !!env.CODEX_API_KEY, auth: CROSS_REVIEW ? readCodexAuth() : undefined }) ? [{ provider: "codex" as const }] : []),
  ];
  // `USAGE_PAUSE`: the run takes the soft pause itself when a window of one of those providers reaches the
  // threshold or an agent hits the limit, and resumes after the window's reset (src/usage.ts, `createUsagePause`).
  const usagePause =
    settings.usagePause === undefined
      ? undefined
      : createUsagePause(settings.usagePause, {
          standing: (now) => readPause(project.root, process.pid, now),
          hold: (pause, now) => holdForUsage(project.root, process.pid, pause, now),
        });
  if (settings.usagePause !== undefined) console.log(usagePauseLine(settings.usagePause, planUsage.map((u) => u.provider)));
  if (planUsage.length) run.update({ usage: [...planUsage] });
  // Also without a plan to show: a ticket's tokens, as its running pass spends them, are the status view's TOKENS column.
  usageWatch = watchUsage({
    logs: join(project.root, ".sandcastle/logs"),
    run: runId,
    providers: planUsage.map((u) => u.provider),
    // A record the next turn replaced is not this watch's to write.
    finished: () => run.finished,
    tokens: { owner: logOwner, write: liveTokenWriter(run, spent) },
    write: (reading) => {
      if (run.finished) return;
      planUsage[planUsage.findIndex((u) => u.provider === reading.provider)] = reading;
      run.update({ usage: [...planUsage] });
      // A pause that cannot be written is no reason to lose the reading: the next one asks again.
      try {
        usagePause?.reading([...planUsage]);
      } catch {}
    },
  });
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
      await timed("", "base gates", () => requireGreenBase(gateProject, image, planFile, true, runId));
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
  const stopWords = (c: StopCause): string => causeWords(c, ref);
  // What a stopped run throws: a safety stop's own error, which names what moved.
  const stopError = (c: StopCause) => ("error" in c ? c.error : new OperatorError(stopWords(c)));

  // Which gate is running, or that the run waits for a machine-wide slot, and
  // the output as it arrives - a gate run is minutes of nothing otherwise.
  // A landing's gate takes a freed gates slot before this run's ticket gates: the one landing worker sets the run's end.
  const runGates = (sandbox: Parameters<typeof gatesIn>[1], id: string, what?: string, priority = false) => {
    markLog(gatesLog(project, id), runId);
    return gatesIn(project, sandbox, gatesLabel(project, ref, id, what), false, {
      wait: () => {
        // The heartbeat says a wait as a wait; the gate time is counted from the first gate (below).
        const step = active.get(id) ?? landing.get(id);
        if (step) step.phase = "gates: waiting for a gates slot";
        run.ticket(id, { note: "waiting for a gates slot" });
      },
      gate: (i, name) => {
        // The step's `since` is set before the wait for a gates slot: the gate time starts at the first gate.
        const step = active.get(id) ?? landing.get(id);
        if (step) {
          step.phase = "gates";
          if (i === 0) step.since = Date.now();
        }
        run.ticket(id, { note: `${i + 1}/${project.gates.length} ${name}` });
      },
      log: gatesLog(project, id),
    }, priority);
  };

  // The run's waits for a sandbox slot. One held back by the run's share, not only by a full pool, is the run
  // record's `waitsForShare`, which the status view's next-to-start rows say.
  const slotWaits = createSlotWaits((held) => {
    try {
      run.update({ waitsForShare: held || undefined });
    } catch {
      /* the record's note only: a throw here would end the wait it describes */
    }
  });
  // A run is silent for as long as its agents are, which for a review can be
  // half an hour. One line every five minutes says it is alive and where, and says when the run
  // has waited for a sandbox slot longer than a typical issue takes: a stall nobody sees otherwise.
  const heartbeat = setInterval(() => {
    const line = heartbeatLine({
      now: Date.now(),
      clock: new Date().toTimeString().slice(0, 5),
      working: [...active].map(([n, a]) => ({ ref: ref(n), phase: a.phase, since: a.since })),
      landing: [...landing].map(([n, l]) => ({ ref: ref(n), ...(l.phase ? { phase: l.phase } : {}), since: l.since })),
      resolving: [...resolving].map(([n, since]) => ({ ref: ref(n), since })),
      slotWait: slotWaits.since,
      typicalMs: typicalIssueMs(typicalTimes(project, [...took].map(([id, ms]) => ms - (waited.get(id) ?? 0)))),
    });
    if (line) console.log(line);
  }, 5 * 60_000);
  heartbeat.unref();

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
  // The hold notes, an agent's <blocked> or the kit's own hold: the ledger says the ticket is held, and gives it no second comment.
  const notes: Note[] = [];
  // Out-of-scope problems the agents named in `<followup>` lines: in the run record as they arrive, filed after the notes below
  // or, when the run stops before then, by the stop. A title filed by an earlier turn of this run is not listed again.
  const followUps = createFollowUpBook(run, { tracker, dryRun: DRY_RUN, write: (fn) => host.write(fn, trackerMade(project.root)), seen: filedThisRun, places: placesThisRun });

  // Each ticket's red landing gate, for its requeue (`ctx.reds`).
  const reds = new Map<string, RedLanding>();

  const gateNames = project.gates.map((g) => g.name).join(", ");

  const slotWanted = { n: 0 };
  const ctx: LandContext = {
    project,
    tracker,
    base,
    gateNames,
    reports,
    run,
    dryRun: DRY_RUN,
    opener: sandboxOpener(gateProject, image, planFile),
    greenBase: (commit, by) => noteGreenCommit(gateProject, image, planFile, commit, by),
    runId,
    withdrawal,
    host,
    // Named apart: a green ticket's wait read as if its branch gates had started again.
    gate: (box, id) =>
      timedLandingGate(timings, { run: runId, project: project.name, issue: id, carried: carriedAtStart.has(id) }, () => runGates(box, id, "landing gate", true)),
    landed: new Map(),
    slotWanted,
    reds,
    timed: (id, took, landed) => writeLandingLine(timings, { run: runId, project: project.name, issue: id, carried: carriedAtStart.has(id) }, took, { ok: didMerge(landed), kind: landed.kind }),
  };

  const results: PromiseSettledResult<Outcome>[] = [];
  const uncommittedWork = (o: Outcome) => keptFor(o, keptWorktrees);
  // A requeued ticket's second pipeline replaces its first in the per-issue lines.
  const dropFirstResult = (id: string) => {
    const earlier = results.findIndex((r) => r.status === "fulfilled" && r.value.issue === id);
    if (earlier >= 0) results.splice(earlier, 1);
  };
  // What will hold a green branch for a person at landing. Said as its pipeline ends: before, a
  // human merge was news only at the end of the run.
  const heldAtLanding = (o: Outcome): string[] => {
    if (o.status !== "green") return [];
    const held = [...protectedChanges(project, o.branch), ...largeFiles(project, o.branch)];
    if (o.unreviewed) held.push("repair not reviewed");
    return held;
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
  // What each ending is described with beyond itself: the agents' report, a kept worktree, a hold note.
  const context = (id: string): Context => {
    const kept = keptWorktrees.find((k) => k.issue === id);
    const hold = notes.some((n) => n.issue === id && n.kind === "hold");
    return { base, gateNames, report: reports.get(id), dryRun: DRY_RUN, ...(kept && { kept: keptPath(project.root, kept.path) }), ...(hold && { hold: "note" as const }) };
  };
  // Every ending and requeue the scheduler tells, recorded in the ledger's words: the state, the outcome and the view's word.
  const ledger = createLedger({ run, outcomes: outcomesFile(project, runId), view, context, bookkeep, dropFirst: dropFirstResult, ref, say: (line) => console.log(line) });
  // The line a requeued ticket's second attempt's setup carries.
  const { requeuedAs } = ledger;
  const baseRed: string[] = [];
  // Who is repairing which failure: the scheduler's endings (`tell`) tell a waiting ticket whether the fix landed.
  // A landing left waiting for a sandbox slot may be waiting for the very slots the waiters hold (the run's
  // share shrank, a cap): they stop waiting and repair, so no wait outlasts the landing it waits for.
  const fixes = createFixBoard(() => slotWanted.n > 0, undefined, (id) => ctx.landed.get(id)?.commit);
  const pipeline = createPipeline({
    project,
    tracker,
    runId,
    dryRun: DRY_RUN,
    repair: settings.repair,
    testRedGate: TEST_RED_GATE,
    prompts,
    overrides,
    open: (branch) => createSandbox({ branch, baseBranch: base, ...sandboxConfig(project, image, planFile) }),
    gate: (box, id) => runGates(box, id),
    baseGate: () => gateBase(gateProject, image, planFile, "base-red", false, runId, false),
    baseWentRed: (tests) => {
      baseRed.push(...tests);
      run.update({ baseRed: [...baseRed] });
    },
    timed,
    run,
    view,
    host,
    requeuedAs,
    results,
    reds,
    landed: ctx.landed,
    fixes,
    reports,
    notes,
    followUps,
    took,
    waited,
    ...(usagePause
      ? {
          limitPause: (phase: string) => {
            try {
              // The pass's last readings are in its log already: the newest of them says which window ran out, not the one up to 15 s old.
              usageWatch?.poll(true);
              return usagePause.limit([...planUsage], phase === "cross-review" ? "codex" : "claude");
            } catch {
              // A pause that cannot be written leaves the limit to stop the run, as it does without the setting.
              return false;
            }
          },
        }
      : {}),
    keptWorktrees,
    tampered,
  });

  // A sandbox slot of the machine pool, for a worker's next ticket (the schedule's `slot`) or a ticket's own after a
  // pause. A landing that waits for a slot goes first (`slotTurn`). `giveUp` ends a wait that is no longer wanted.
  // `keep`: beside another run the tickets leave the last slot of the run's share to landing, as `pipelineWorkers`
  // leaves one of the machine's for a run alone; a dry run lands nothing.
  const sandboxSlot = async (label: string, giveUp: () => boolean): Promise<SlotLease | undefined> => {
    await slotTurn(slotWanted);
    const wait = slotWaits.begin();
    try {
      return await leaseSlot("sandboxes", `${project.name} ${label}`, wait.onWait, undefined, giveUp, false, !DRY_RUN);
    } finally {
      wait.end();
    }
  };
  // One attempt of a ticket (schedule.ts runs it), in the sandbox slot its worker leased (`slot`): the usage check and
  // the tracker's word before it, then its pipeline.
  const attempt = async (issue: Issue, { last, juncture, paused, resolveWaitMs, slot }: { last(): boolean; juncture(phase: string, park?: Park): Promise<void>; paused(): boolean; resolveWaitMs?: number; slot?: SlotLease }): Promise<Attempted<Outcome, Outcome>> => {
    // The ticket's sandbox slot, which it gives back while it waits out a pause and takes again on the resume.
    // A wait for one ends when the run is paused (false): the ticket then waits at its start for the resume.
    let lease: SlotLease | undefined = slot;
    const take = async () => {
      lease = await sandboxSlot(ref(issue.id), paused);
      return lease !== undefined;
    };
    const give = () => {
      lease?.release();
      lease = undefined;
    };
    // At its start the ticket gives the slot back for a pause and takes one only once it goes on (below).
    const start: Park = { suspend: async () => give(), resume: async () => {} };
    await pausing.waitOutPause(usagePause !== undefined, paused, (phase) => juncture(phase, start));
    const line = await usageStop(env, undefined, () => planUsage.find((u) => u.provider === "claude"));
    noteReading();
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
    const parkable = (park?: Park): Park => ({
      suspend: async () => {
        await park?.suspend();
        give();
      },
      resume: async () => {
        // Paused again while it waits for the slot: it parks again, as a ticket at its start does.
        while (!(await take())) await juncture("start", { suspend: async () => {}, resume: async () => {} });
        await park?.resume();
      },
    });
    const result = await (async () => {
      try {
        // A pause gives the slot back and waits; the ticket then leases its own, in the time parked. Its worker's slot
        // was gone too when the run was paused as the attempt began.
        for (await juncture("start", start); !lease; await juncture("start", start)) await take();
        return await pipeline(issue, { juncture: (phase, park) => juncture(phase, parkable(park)), paused, resolveWaitMs });
      } finally {
        give();
      }
    })().then(
      (value) => ({ status: "fulfilled", value }) as const,
      (reason: unknown) => ({ status: "rejected", reason }) as const,
    );
    const check = tampered.has(issue.id) ? { error: tampered.get(issue.id) } : undefined;
    tampered.delete(issue.id);
    // Parked by a pause when the run stopped: not a crash. The schedule ends it as parked, its record still `paused`.
    if (result.status === "rejected" && result.reason instanceof StoppedWhileParked) {
      bookkeep(issue.id, () => view.finish(issue.id, "stopped", true));
      return attempted(issue.id, result, check);
    }
    // Its ending arrives complete: an agent's hand-back is read now, not patched in after the schedule.
    const ended = result.status === "fulfilled" ? { ...result, value: handBack(result.value, tracker, { uncommitted: uncommittedWork(result.value) !== undefined, dryRun: DRY_RUN }) } : result;
    // A requeued ticket's second pipeline replaces its first in the per-issue lines.
    dropFirstResult(issue.id);
    results.push(ended);
    // The state it ends on is the ledger's, as the scheduler tells the ending; written here are the
    // facts of the pipeline, and a green branch's wait for landing.
    if (ended.status === "fulfilled") {
      const value = ended.value;
      const report = attempted(issue.id, ended, check);
      bookkeep(issue.id, () => {
        const tokens = spent.get(issue.id);
        run.ticket(issue.id, {
          commits: value.commits,
          minutes: Math.round((took.get(issue.id) ?? 0) / 60_000),
          ...(tokens ? { tokens: tokenBrief(tokens) } : {}),
          ...(value.failing?.length ? { failing: value.failing } : {}),
          ...(value.ungated ? { ungated: value.ungated } : {}),
          ...(value.gap ? { gap: value.gap } : {}),
          ...(value.changelog?.length ? { changelog: value.changelog } : {}),
          ...(value.changelogDropped ? { changelogDropped: value.changelogDropped } : {}),
          ...(value.unmet ? { unmet: value.unmet } : {}),
        });
        run.update({ typical: typicalTimes(project, [...took].map(([id, ms]) => ms - (waited.get(id) ?? 0))) });
        // With nothing left to start, the pane closes: five panes each
        // frozen on a finished agent's summary read as five stuck sandboxes.
        // A stopped run starts nothing, whatever is still queued or parked.
        const word = report.kind === "stopped" ? "stopped" : uncommittedWork(value) ? "uncommitted" : finishWord(value);
        view.finish(issue.id, word, check !== undefined || last());
      });
      // Its outcome now, not only at its landing: a branch waiting for landing had none for this run.
      if (report.kind === "green") bookkeep(issue.id, () => ledger.ready(issue.id, value, heldAtLanding(value)));
      // To the landing worker as it ends, not when the slowest pipeline does.
      return report;
    }
    let limited = false;
    bookkeep(issue.id, () => {
      // Kept open even at the end of the queue: a crash is for a human to read.
      view.finish(issue.id, "crashed");
      limited = hitLimit(project.root, issue.id);
    });
    // A pipeline that crashed on its own keeps its own error; a failed check after it stops the run all the same.
    return attempted(issue.id, ended, check, limited);
  };

  const pausing = createPauseHandling({
    record: (paused) => run.update({ paused }),
    say: (line) => console.log(line),
    ref,
    releaseAwake,
    holdAwake,
    refresh: () => view.refresh(),
  });
  // The landing worker's ports, with each landing in flight on the heartbeat's list.
  const landingPorts = landingWork(ctx);
  const landings: typeof landingPorts = {
    ...landingPorts,
    land: async (o) => {
      landing.set(o.issue, { since: Date.now() });
      try {
        return await landingPorts.land(o);
      } finally {
        landing.delete(o.issue);
      }
    },
  };
  const tell = (c: Change<Outcome, Outcome, Blocker>) => {
    fixes.told(c);
    switch (c.kind) {
      case "landing":
        // Only the run line: the next landing writes it again.
        run.update({ stage: `landing ${c.at}/${c.of}` });
        return;
      case "requeued":
        // Written before the ticket is queued again, with the line its second pipeline's setup carries.
        ledger.tell(c);
        return holds.tell(run, c);
      case "resolve waits":
        // The heartbeat's wait counts from the first telling; a later one only changes the list.
        if (!resolving.has(c.id)) resolving.set(c.id, Date.now());
        return holds.tell(run, c);
      case "resolve starts":
        resolving.delete(c.id);
        return holds.tell(run, c);
      case "ended":
        // A wait the run's stop cut short is told no "resolve starts".
        resolving.delete(c.id);
        // Its label refuses it, found as it would have started: that ticket only, never the run.
        if (c.ending.kind === "not begun" && c.ending.why.kind === "refused label") console.log(`  ${c.ending.why.reason}`);
        // How each ticket's part in the run ended: the ledger records it.
        return ledger.tell(c);
      case "stopped landing": {
        // Said as the stop first holds, not at the run's end: the run goes on printing `working` lines
        // for tickets in flight, and a person would read each as a run that still lands.
        const error = stopError(c.cause);
        run.update({ stopped: String((error as Error).message ?? error) });
        console.log(stoppedLine(c.cause, ref));
        return view.refresh();
      }
      case "demand":
        // Before the pipelines ask for their slots, so the share they are held to is worked out from it.
        setDemand(c.n);
        return poolValues();
      case "paused":
      case "resumed":
      case "pause stopped":
        return pausing.told(c);
      case "blocked":
        return bookkeep(c.id, () => run.ticket(c.id, { note: blockedNote(c.on, new Set(c.inFlight), new Set(c.landed), new Map(c.ended.map((id) => [id, ledger.endedAs(id)]))) }));
      case "unreleased":
        console.log(`${ref(c.id)}: could not start the tickets that wait for it (${errorLine(c.error)}); they wait for the next run.`);
        return;
      default:
        return holds.tell(run, c);
    }
  };

  // Files the follow-ups still unfiled and says what each became. Where the shared .git changed, `unsafe` says
  // why nothing is written to the tracker (a ticket file is a commit on that base): they stay in the record to file by hand.
  const fileTheFollowUps = async (unsafe?: string) => {
    for (const f of await followUps.file(unsafe)) {
      console.log(
        f.id
          ? `${ref(f.from)}: filed ${ref(f.id)} for triage - ${f.title}`
          : f.failed
            ? `${ref(f.from)}: could not file a follow-up (${f.failed}): ${f.title}`
            : `[dry run] would file for triage, from ${ref(f.from)}: ${f.title}`,
      );
    }
  };

  // The run stops: the summary still prints, headed by why - a stack trace was all a
  // stopped run left, and its report then said "Run finished". The agents' follow-ups are filed first, or
  // (`safety`: the shared .git changed) left in the record to file by hand, so the summary lists them either way.
  const stopLanding = async (error: unknown, safety: boolean): Promise<never> => {
    const why = String((error as Error).message ?? error);
    run.update({ stopped: why, paused: undefined });
    try {
      await fileTheFollowUps(safety ? `${guardWords(error).what}, so nothing more was written to the tracker` : undefined);
    } catch (e) {
      // Whatever went wrong here must not replace the reason the run stopped.
      console.log(`Could not file the agents' follow-ups: ${errorLine(e)}`);
    }
    console.log(`\n${await closingReport(project)}\n`);
    throw error;
  };

  const { endings, stop } = await schedule
    .run({ workers, concurrency: CONCURRENCY, slot: (wanted) => sandboxSlot("next ticket", () => !wanted()), attempt, ...landings, tell, pause: { read: () => (usagePause ? usagePause.source.read() : readPause(project.root, process.pid)) } })
    .catch((error: unknown) => {
      clearInterval(heartbeat);
      usageWatch?.stop();
      // A write the host git refused is a safety stop as it happens; a `.git` change the scheduler's own state
      // would have named is lost with its rejection, and the writer's check refuses such a write by itself.
      return stopLanding(error, host.failed !== undefined);
    });
  clearInterval(heartbeat);
  // A run whose last ticket landed while it was paused goes on to its verify and summary: not paused any more, and awake.
  await pausing.end();
  // The last reading is in the record before the closing summary reads it.
  usageWatch?.stop();
  // The cause the closing summary names: the most severe, a `.git` change before a limit.
  const headline = stop.headline;
  const stopLine = headline && stopWords(headline);
  // The tickets the pipelines took in, and the ones of them no attempt began for.
  const entered = [...endings.values()].filter((e) => e.kind !== "waiting" && !(e.kind === "not begun" && e.why.kind === "refused label"));
  const notStarted = entered.filter((e) => e.kind === "not begun").length;
  // The tickets the stop left unstarted, recorded in the run's last words.
  ledger.close(endings, stopLine);
  // A safety stop (a `.git` change, after a pipeline or under the landing worker, or a refused
  // write) landed nothing more: the run stops, headed by the most severe of them.
  if (stop.landsNothing && headline) await stopLanding(stopError(headline), true);

  // What landing decided, for the closing notification and the verify, from the ledger's entries.
  const { merged, regenerated, notLanded, needsHuman, withdrawn } = accountLanding(ledger.entries.values());

  // Whatever the agents said about a ticket that did not land (red gate,
  // conflict, nothing to change) would otherwise live only in an archived log.
  // The ledger has the words, and none for a ticket with a hold note: it gets that note.
  const comments = [...ledger.entries.values()].flatMap(({ id, said }) => (said.tracker?.kind === "comment" ? [{ issue: id, kind: "comment" as const, text: said.tracker.text }] : []));
  // Through the landing worker's writer: a ticket-file tracker commits each one on the base branch.
  for (const n of [...notes, ...comments]) {
    if (DRY_RUN) console.log(`[dry run] would ${n.kind === "hold" ? "hold for a human" : "comment on"} ${ref(n.issue)}: ${n.text.slice(0, 120)}`);
    else {
      try {
        await host.write(() => (n.kind === "hold" ? tracker.hold(n.issue, n.text) : tracker.comment(n.issue, n.text)), trackerMade(project.root));
      } catch (error) {
        console.log(`Could not update ${ref(n.issue)}: ${errorLine(error)}`);
      }
    }
  }
  // Through the same writer, after the run's own tickets: a ticket file is a commit on the base branch.
  await fileTheFollowUps();
  // A note refused by the writer's `.git` check: the verify would start a container and run git on the host.
  if (stop.landsNothing) await stopLanding(stopError(stop.headline!), true);

  // -------------------------------------------------------------------------
  // Phase 4: the gates on the merged base branch. Each branch was gated on its
  // own; together they can still be red.
  // -------------------------------------------------------------------------

  let verify: Gate[] | undefined;
  let verifySkipped: { commit: string; by?: string } | undefined;
  let newDockerfiles: string[] = [];
  if (merged.length > 1 || regenerated > 0) {
    // Verify is proof that the merged base is green: a landing's gates, or those of a branch that held the base, may
    // have run on exactly this tip, and the green-base record says so (it names no tip after a failed note: then it runs).
    verifySkipped = greenProofOfBase(gateProject, image, planFile);
    let gated: { gates: Gate[]; failures: GateRun["failures"] } = { gates: [], failures: [] };
    if (verifySkipped) console.log(`${verifySkippedLine(base, verifySkipped)}.`);
    else {
      // The scheduler told its last demand, 0: the verify's own sandbox is one slot.
      setDemand(1);
      gated = await timed("", "verify", () => verifyBase(gateProject, image, planFile, runId)).finally(() => setDemand(0));
    }
    verify = gated.gates;
    newDockerfiles = changedDockerfiles(project, startTip, base);
    // A red merged base said "do not push" with nothing to read: its output goes where the base gates' does.
    const at = sh("git", ["rev-parse", "--short", base], project.root);
    if (writeGateLog(join(project.root, VERIFY_LOG), `# gates on the merged ${base} at ${at}, ${new Date().toISOString()}: ${gateLine(verify)}`, gated.failures)) {
      for (const f of gated.failures) console.log(`\n--- verify ${f.name} (exit ${f.exitCode}), last lines:\n${f.output.split("\n").slice(-15).join("\n")}`);
      console.log(`Full output: ${VERIFY_LOG}`);
    }
  }
  run.update({ stage: "report" });

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
      console.log(`  CRASHED  ${String(r.reason).split("\n")[0].slice(0, 200)}`);
      continue;
    }
    const o = r.value;
    const state = final[o.issue]?.state === "red" ? "gate red" : (final[o.issue]?.state ?? o.status);
    const repaired = repairWords(o);
    const time = ticketTime(took.get(o.issue));
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
  run.update({
    verify: verify ? { green: verify.every((g) => g.pass), line: gateLine(verify), image, ...(verifySkipped ? { skipped: verifySkipped } : {}), ...(newDockerfiles.length ? { dockerfiles: newDockerfiles } : {}) } : null,
    keptWorktrees,
    dryRunCheck,
  });
  console.log(`\n${await closingReport(project, turn && { level: turn.settings.autonomy, turn: turn.turn })}\n`);
  view.close(
    `merged ${merged.length}` +
      (notLanded ? `, not landed ${notLanded}` : "") +
      (needsHuman ? `, needs a human ${needsHuman}` : "") +
      (withdrawn ? `, withdrawn ${withdrawn}` : "") +
      ` of ${entered.length}`,
  );
  return true;
};
