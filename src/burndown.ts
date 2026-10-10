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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { format } from "node:util";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, REVIEW_MODEL, crossReview, implAgent, implementNote, type Override, reviewWithFallback, ticketOverride } from "./agents.ts";
import { red, runApiKeyLine } from "./api-key.ts";
import { PERSON_MARK } from "./autonomy.ts";
import type { Project } from "./config.ts";
import { BaseRedError, changedDockerfiles, FAILING_TESTS_SHOWN, type Gate, type GateRun, failingTestFile, failingTests, failureKey, gateBase, gateLine, gateMs, gateRed, requireGreenBase, hooksThatRanClean, stepTimes, timedGate, timedLandingGate, baseRecordedGreen, BASE_RED, withQueued, writeLandingLine, rewroteLine, runGates as gatesIn, noteGreenCommit, type ProofKind, likelyLoad, rerunRedVerify, verifyPlan, verifyBase, verifyFailing, VERIFY_LOG } from "./gates.ts";
import { blockedNote, blockerProblems, blockerResolver, blockerTicket, commentBlockLine, commentOnlyBlocks, openBlockers, openBlockersNow, refLabel, type Blocker } from "./blockers.ts";
import { assertGitConfigBaseline, assertGitUnchanged, assertWorktreeRecords, checkBeforeClose, disableHostGitGc, disableHostGitHooks, gitFingerprint, GuardStop, guardWords, holdAndReap, largeFiles, openOrAbandon, pinHostGitConfig, protectedChanges, protectedPlanLines, pruneBackup, recordGitConfigStart } from "./guard.ts";
import { checkHooks, hiddenReferences, reportHookCheck, unmatched, unmatchedLines, writePlan } from "./lean.ts";
import { IN_HERDR, openSandboxView, type SandboxView, sandboxPanes } from "./herdr.ts";
import { registerRun } from "./live-runs.ts";
import { agentBaseline, peakOf, pressureFields, pressureOf, recordPeak, sampling } from "./peaks.ts";
import { isTicketState, type PlanUsage, type RunRecord, type TicketRecord, type TicketState } from "../mod/hooks/run-record.ts";
import { estimateSlots, joinPool, leaseSlot, limit, myShare, otherRuns, recordOfRun, setDemand, type SlotLease, splitAtStart, startLines, usage, type WaitReason } from "./pool.ts";
import {
  addTokens, agentLogging, archiveFinishedLogs, assertCleanBase, baseIsTheRunsLine, forgetHead, gatesLog, holdAwake, keepAwake, landOnlyHead, limitResets, logExpansionFailure, logSaysLimit, markLog, narrowReviewBase, NO_TOKENS, openStatusPane, preflight, readHeads, recordHead, relabelContextWindow, releaseAwake, reviewedOnlyHead,
  createLoadMeter, createTailFilter, namedTicketsFromEnv, recordRun, renderPrompts, runTokens, type Tokens, tokenBrief, estimate, isCarried, isRemainder, tokenLine, typicalTimes, firstSlotWait, usedArgs, logOwner, implChangelogView, liveTokenWriter,
} from "./run.ts";
import { mergeCheckGap, mergeTree, rebuildOnBase, resetMergeCheckGap, mergeTreeSupported, noteMissingObjects, rewrittenNote, splitStrays, namedStraysView, strayChanges, strayNote, type NamedStray } from "./resolution.ts";
import { kitVersion } from "./upgrading.ts";
import { resolveVersions, versionsLine } from "./versions.ts";
import { cpusLine, credentials, ensureImage, errorLine, machineSettings, ownCommits, ownRange, projectApiKeySpend, sandboxConfig, sandboxCpus, sh, staleBaseParents } from "./sandbox.ts";
import { readDockerInfo, turnDockerInfo } from "./runtime.ts";
import { poolWarningsNow } from "./size.ts";
import { LATEST_ISSUE, ensureTriageLabel, makeTracker, type Ticket, type Tracker } from "./tracker.ts";
import { closingReport, summary } from "./report.ts";
import { notifyCommand, runNotify } from "./notify.ts";
import { type ResolvedSettings, resolveSettings, settingsGroup } from "./run-settings.ts";
import { createPauseHandling, createUsagePause, readCodexAuth, showsCodexUsage, showsPlanUsage, usageLine, usagePauseLine, usageReadingLost, usageStop, type UsageWatch, watchUsage } from "./usage.ts";
import { lockWorktree, releaseBranchWorktree, unlockAll, unlockWorktree } from "./worktree-lock.ts";
import { OperatorError, reportedError, SlowStartError } from "./errors.ts";
import { hostIdentity, regensFor, resolveGenerated, shq } from "./generated.ts";
import { sandboxOpener } from "./land.ts";
import {
  carriedBranch, carriedMergeLine, conflictLine, createHostGit, rebuiltLine, landingOfTree, firstAttemptIdleRepairs, firstAttemptRepairs, firstAttemptReviewCommits, greenCarriedLine, type HostGit, didMerge, isAncestor, type LandContext, landingSlotNote, landingWork, pipelineWorkers, type RedLanding, repairFromRed, reviewedCarriedLine, slotTurn, trackerMade,
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
  /** An agent answered `<changelog>none</changelog>` and no pass gave a line: the ticket needs no entry (not "no suggested line"). */
  changelogNone?: boolean;
  /** Why each dropped tag was (`changelogScan`), as many as the pass that gave the lines saw; older records have none. */
  changelogDroppedWhy?: string[];
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
 * The `.git` check at a pipeline's end, in its `finally`, before its sandbox closes (Sandcastle's close runs
 * `git status` on the host in the worktree). A failure is kept (`kept`) for the attempt, which stops the run with
 * it, and never thrown: thrown from the `finally`, it replaced a red or no-change pipeline's result, which was then
 * recorded as a finished branch that "lands on a later run".
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
export const attempted = (issue: string, result: PromiseSettledResult<Outcome>, check?: { error: unknown }, limited: { resets?: string } | boolean = false): Attempted<Outcome, Outcome> => {
  const tampered: StopCause[] = check ? [{ kind: "tampered", error: check.error }] : [];
  // Parked by a pause when the run stopped: thrown on to the scheduler, which ends it as parked, with the check -
  // dropped, a `.git` change found after a non-safety stop went unreported, as no check closes the run.
  if (result.status === "rejected" && result.reason instanceof StoppedWhileParked) throw new StoppedWhileParked(tampered);
  if (result.status === "rejected") return { kind: "crashed", error: result.reason, causes: [...tampered, ...(limited ? [{ kind: "plan limit" as const, ticket: issue, ...(typeof limited === "object" && limited.resets !== undefined && { resets: limited.resets }) }] : [])] };
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
export const hitLimit = (root: string, issue: string) => planLimit(root, issue) !== undefined;

/** The limit a ticket's agent hit, with the reset time its line gives when it gives one; undefined when none. Same reading as `hitLimit`. */
export const planLimit = (root: string, issue: string): { resets?: string } | undefined => {
  const logs = join(root, ".sandcastle/logs");
  if (!existsSync(logs)) return undefined;
  let found: { resets?: string } | undefined;
  for (const f of readdirSync(logs)) {
    // Not the .jsonl sidecar: its last lines are raw tool results, and a file the agent merely read could say "usage limit".
    if (!f.endsWith(".log") || logOwner(f) !== issue) continue;
    const log = readFileSync(join(logs, f));
    const from = passStarts.get(f) ?? 0;
    const text = log.subarray(log.length < from ? 0 : from).toString("utf8");
    if (!logSaysLimit(text)) continue;
    const resets = limitResets(text);
    found = { ...found, ...(resets !== undefined && { resets }) };
  }
  return found;
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
// `attrs`: an opening tag may carry attributes (`<unmet who="person">`), returned beside the text; only a tag
// asked for with `withAttrs` takes any, so `<changelog x>` stays prose as before.
const ownLineMatches = (text: string, tag: string, withAttrs = false): { attrs: string; text: string }[] => {
  const unfenced = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "");
  // A tag quoted in inline code inside the line (``Fixed: `<changelog>none</changelog>` is no line``) is the line's
  // words, not a tag: its brackets are masked while matching, so the line is neither cut there nor refused.
  const masked = unfenced.replace(/`[^`\n]+`/g, (code) => code.replace(/</g, "\uE000").replace(/>/g, "\uE001"));
  const unmask = (t: string) => t.replace(/\uE000/g, "<").replace(/\uE001/g, ">");
  const open = withAttrs ? `<${tag}(?:[ \\t]+([^<>\\n]*?))?[ \\t]*>` : `<${tag}()>`;
  return [...masked.matchAll(new RegExp(`^[ \\t]*${open}((?:(?!<${tag}[ \\t>])[\\s\\S])*?)</${tag}>[ \\t]*$`, "gm"))].map((m) => ({ attrs: unmask(m[1] ?? ""), text: unmask(m[2]) }));
};
const ownLineTags = (text: string, tag: string): string[] => ownLineMatches(text, tag).map((m) => m.text);
const lineOf = (tag: string) => (text: string): string | undefined => {
  const said = ownLineTags(text, tag).at(-1)?.replace(/\s+/g, " ").trim();
  return said && said !== "..." ? cutAtWord(said, UNGATED_MAX) : undefined;
};
export const ungatedOf = lineOf("ungated");
// An agent's `<unmet>...</unmet>` line: the acceptance criterion it knowingly left undone. Read the same way.
// `<unmet who="person">...</unmet>` says the remainder needs a person (access, a deploy, a human-only file, a
// decision): the note keeps that as `PERSON_MARK` in front, so the run record's `unmet` carries it to the
// report and the status view, and no other run is spent on it (`needsDecision`).
export const unmetOf = (text: string): string | undefined => {
  const last = ownLineMatches(text, "unmet", true).at(-1);
  const said = last?.text.replace(/\s+/g, " ").trim();
  if (!last || !said || said === "...") return undefined;
  const byPerson = /(^|\s)who\s*=\s*(["']?)person\2(\s|$)/i.test(last.attrs);
  return cutAtWord(byPerson && !said.startsWith(PERSON_MARK) ? PERSON_MARK + said : said, UNGATED_MAX);
};
// The resolver's `<stray path="...">reason</stray>` lines: each cleanly merged file it had to change, and why. Read like
// every own-line tag, so a tag named in prose or code is no claim; a line with no path or no reason names nothing.
export const strayNamesOf = (text: string): NamedStray[] =>
  ownLineMatches(text, "stray", true).flatMap((m) => {
    const path = m.attrs.match(/(?:^|\s)path\s*=\s*(["'])(.+?)\1/)?.[2]?.trim();
    const why = m.text.replace(/\s+/g, " ").trim();
    return path && why && why !== "..." ? [{ path, why: cutAtWord(why, 300) }] : [];
  });
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

// The last paragraph of an implementer's final message, with the kit's own tags (`<promise>`, `<unmet>`,
// `<changelog>`, `<followup>`, `<ungated>`) and fenced blocks taken out first: a caveat ("I did not check that
// the new test fails without the change") sits in the closing prose, and no other pass reads that prose. Cut at
// a word to UNGATED_MAX; undefined when the message has no prose. A `<report>` keeps its words and loses only its
// tags: with a tracker agents do not write to, the implementer's prose for the ticket, caveat and all, is in it.
export const closingParagraphOf = (text: string): string | undefined => {
  const prose = text
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "")
    .replace(/^[ \t]*<(promise|unmet|changelog|followup|ungated)\b[^>\n]*>[\s\S]*?<\/\1>[ \t]*$/gm, "")
    .replace(/<\/?report>/g, "");
  const last = prose.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean).at(-1);
  return last ? cutAtWord(last, UNGATED_MAX) : undefined;
};
// What a full review is shown of it, for `IMPL_SAID`: the paragraph quoted, with the ask to make any check the
// implementer says it did not make. Empty when there is none, so the prompt carries no heading over nothing.
export const implSaidView = (said: string | undefined): string =>
  said
    ? "# What the implementer said last\n\nThe last paragraph of the implementer's final message, quoted as it wrote it. If it says " +
      "it did not check something (a test not shown to fail without the change, a platform it did not run), make that check yourself " +
      "before you accept the claim:\n\n" +
      `${said.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`
    : "";

// The `<changelog>...</changelog>` lines of one agent's final message, each one line, in order.
// Unlike `<ungated>` every own-line tag counts, not the last alone: a ticket may need several lines. An
// empty tag or the echoed placeholder "..." does not count. A changelog line is one or two sentences, so a
// tag that is longer than CHANGELOG_MAX, spans list items or holds a commit sha is an agent's whole message
// (a prose mention of the tag can pair with a later closing tag), not a line: it is counted in `dropped`
// and never shown, least of all cut off. `none` or `n/a` alone in a tag (any case, a full stop allowed) is the
// answer the prompts name for a change nobody outside the code would notice: it is no line, and `none: true`
// says an agent gave it (the key is absent otherwise).
export const CHANGELOG_MAX = 500;
const saysNone = /^(?:none|n\/a)\.?$/i;
const listItem = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]/m;
const commitSha = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
// `why` has one entry per dropped tag, in order: what the closing summary says of it (`droppedWords`).
export const changelogScan = (text: string): { lines: string[]; why: string[]; none?: true } => {
  const lines: string[] = [];
  const why: string[] = [];
  let none = false;
  for (const raw of ownLineTags(text, "changelog")) {
    const said = raw.replace(/\s+/g, " ").trim();
    if (!said || said === "...") continue;
    if (saysNone.test(said)) none = true;
    else if (said.length > CHANGELOG_MAX) why.push(`too long (${said.length} characters)`);
    else if (listItem.test(raw)) why.push("spans list items");
    else if (commitSha.test(said)) why.push("holds a commit sha");
    else lines.push(said);
  }
  return { lines, why, ...(none ? { none: true as const } : {}) };
};
export const changelogRead = (text: string): { lines: string[]; dropped: number; none?: true } => {
  const { lines, why, none } = changelogScan(text);
  return { lines, dropped: why.length, ...(none ? { none } : {}) };
};
export const changelogOf = (text: string): string[] => changelogScan(text).lines;

/** A ticket's dropped tags as the run keeps them: how many, and why where a pass said (an older record has a count alone). */
export type ChangelogDrops = { count: number; why: string[] };

// Adds one pass's lines to the ticket's and returns how many tags were no line. A full review that gives
// any lines gives the full set for the branch (its prompt asks it to restate the implementer's along with
// its own), so its set replaces the earlier one: a rewording then shows once however few words it shares,
// and a distinct change that shares words is not dropped for it. The tags the implementer's message had
// dropped went with that message: `drops`, when given, becomes the review's own. A narrow pass (after a
// conflict resolution, a base merge or a repair) sees only what it reviewed, not the branch: its set is
// lines for what it changed itself, so it adds to the earlier set - replacing would drop every line the
// implementer gave - and its drops are added. A pass that gives none (no tag, or only `none`) leaves the
// earlier set standing and adds its drops. Two lines of one pass are two changes, however alike their words ("`size --json`
// prints ..." and "`status --json` prints ...").
export const addChangelog = (have: string[], text: string, narrow = false, drops?: ChangelogDrops): number => {
  const read = changelogScan(text);
  const replaces = !!read.lines.length && !narrow;
  if (drops) {
    if (replaces) {
      drops.count = read.why.length;
      drops.why = [...read.why];
    } else {
      drops.count += read.why.length;
      drops.why.push(...read.why);
    }
  }
  if (!read.lines.length) return read.why.length;
  if (narrow) {
    for (const line of read.lines) if (!have.includes(line)) have.push(line);
  } else have.splice(0, have.length, ...read.lines);
  return read.why.length;
};

/** A problem outside its ticket that an agent named in a `<followup>` line: the kit files it for triage once the run has landed. */
export type FollowUp = { title: string; evidence: string; from: string; phase: string };
/** A follow-up as the run record keeps it: `id` is the ticket filed, absent in a dry run (which files nothing) or when filing failed (`failed`). */
export type FiledFollowUp = { title: string; from: string; phase: string; id?: string; failed?: string };

// A ticket title is short: a longer one is a paragraph, cut at a word. GitHub refuses more than 256.
export const FOLLOWUP_TITLE_MAX = 120;
// Every own-line `<followup>title - evidence</followup>` of one final message, in order. An agent that
// left a problem in prose lost it (nobody reads the message), so the kit reads these and files them.
// The title is what comes before the first " - " outside double quotes ("...", “...”) and backticks, so a
// title quoting UI text or a command that holds one keeps it; with none outside them (an unclosed quote)
// it is the first " - ". The first and not the last: the evidence is often a command and its output.
// The echoed placeholder counts for nothing.
const titleSplit = (said: string): number => {
  let quote = "";
  for (let i = 0; i < said.length; i++) {
    const c = said[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"') quote = '"';
    else if (c === "“") quote = "”";
    else if (c === "`") quote = "`";
    else if (said.startsWith(" - ", i)) return i;
  }
  return said.indexOf(" - ");
};
export const followUpsOf = (text: string): Omit<FollowUp, "from" | "phase">[] =>
  ownLineTags(text, "followup").flatMap((raw) => {
    const said = raw.replace(/\s+/g, " ").trim();
    if (!said || said === "..." || said === "title - one line of evidence") return [];
    const at = titleSplit(said);
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
// pass", "every remaining criterion is met" ("all 36 remaining ... match" too) and a test that "covers the gap the
// ticket describes": a first run flagged each of these as a gap. And a remaining thing the reviewer calls right
// ("the only remaining mention is in past entries, which is correct"), and an omission the ticket itself asked
// for ("left alone, as the ticket asked"). And prose about a gap already dealt with: "Gap fixed.", "were rightly left
// alone", "each unfixed case" of a test, "the branch had opened this gap" and remaining things that are "different
// rules that still apply". Narrowly: "every unfixed caller still reads the old key" and "the remaining issues that
// still apply ... are not fixed" are real gaps, and a negation matches its clause (`isGap` splits a sentence at a contrast).
const GAP_NEGATED =
  /\b(?:nothing|none|no|neither|without|zero)\b(?:\s+\w+){0,3}?\s+(?:remains?|remaining|gaps?)\b|\bremains?\s+(?:unchanged|unaffected|untouched|green|correct|valid|intact|passing|accurate|true|compatible|in\s+place|the\s+same|as\s+(?:is|before|it\s+was))\b|\b(?:no|nothing|none)\b[^.]*\bleft\s+(?:alone|unfixed)\b|\b(?:every|each|all(?:\s+the)?)\s+(?:\d+\s+)?remaining\b|\bremaining\s+(?:\w+\s+){0,3}?(?:pass(?:es|ed)?|(?:is|are)\s+(?:met|green|fine|done)|hold)\b|\b(?:covers?|covered|clos(?:es|ed|e)|fill(?:s|ed)?|fix(?:es|ed)?|address(?:es|ed)?)\s+(?:the|this|that|a)\s+gap\b|\bremaining\b.*,\s*which\s+(?:is|are)\s+(?:correct|fine|expected|intended|deliberate|ok(?:ay)?)\b|\bleft\s+alone,?\s+as\s+the\s+(?:ticket|issue|brief)\s+(?:asked|said|says|required?|requires|specified|wanted|directed|instructed)\b|\b(?:rightly|correctly|properly|deliberately|intentionally)\s+left\s+(?:alone|as\s+is|unfixed)\b|\bgaps?\s+(?:is\s+|was\s+|now\s+|has\s+been\s+)?(?:fixed|closed|addressed)\b|\b(?:each|every)\s+unfixed\s+(?:case|run|test)s?\b(?![^.]*\bstill\b)|\bhad\s+(?:opened|introduced|created|caused)\s+(?:this|the|that|a)\s+gap\b|\bremaining\s+(?:\w+\s+){0,3}?(?:are|is)\s+(?:different|other|separate|unrelated)\b/i;
// A gap reported with its fix ("found one gap ... and fixed both"). It says nothing of what follows it: in "I fixed
// all the typos; one gap remains in the README" the gap is after the fix, and "I have not fixed it" and "I have not yet fixed it" are no fix.
const GAP_FIXED = /\bfound\b.*\band\s+fixed\b|(?<!(?:\bnot|\bnever|n't)\s+(?:(?:yet|fully|really|actually|properly)\s+)?)\bfixed\s+(?:both|all|each|it|them|these|those)\b/i;
// A contrast ends a clause: a negation in one ("I fixed the gap in src, but the same gap remains in skill/run.md")
// must not hide a gap named in the other. A semicolon ends one too.
const CONTRAST = /;|,?\s+but\s+/i;
const isGap = (sentence: string): boolean => {
  const clauses = sentence.split(CONTRAST);
  // A fix reports the gaps before it ("found a gap, but fixed it"), so only the clauses from the last fix on count.
  const fix = clauses.findLastIndex((c) => GAP_FIXED.test(c));
  return clauses.slice(Math.max(fix, 0)).some((clause) => {
    if (!GAP_WORDS.test(clause) || GAP_NEGATED.test(clause)) return false;
    const fixed = GAP_FIXED.exec(clause);
    return !fixed || isGap(clause.slice(fixed.index + fixed[0].length));
  });
};
// A line that is a heading, not a sentence: a Markdown heading, or a short bold label ("**Checked and left as
// is**"). It would otherwise join the paragraph under it and be quoted with it.
const MD_HEADING = /^#{1,6}\s/;
const BOLD_LINE = /^((?:[-*+•]\s+)?)(?:\*\*([^*]+)\*\*|__([^_]+)__):?$/;
const LABEL_WORDS = 6;
// A wholly bold line is a label only when its text reads like one: at most six words, no sentence punctuation,
// and no colon with words after it. A reviewer who writes the gap itself in bold ("**One gap remains: the
// Linux path is untested.**") has said a sentence, which is read as prose with its bold markers dropped.
const boldLine = (line: string): { label: boolean; prose: string } | undefined => {
  const m = BOLD_LINE.exec(line);
  if (!m) return undefined;
  const inner = (m[2] ?? m[3]).trim().replace(/:$/, "");
  const label = !/[.!?;]|:\s*\S/.test(inner) && inner.split(/\s+/).length <= LABEL_WORDS;
  return { label, prose: `${m[1]}${inner}` };
};
// Code is no prose of the reviewer's: `gap-in-prose` is a file name, and `\b` treats its hyphen as a word edge.
const withoutCode = (sentence: string) => sentence.replace(/`[^`\n]*`/g, "");
// Nor is text in double quotes: a review of the detector itself quotes its example sentences ("The gap
// remains; I have not yet fixed it."), and an approving one quotes what a document says. Only the test skips it:
// the sentence a person reads keeps its quoted words. A code span goes first, so a quote mark inside it pairs with nothing.
const QUOTED = /`[^`\n]*`|"[^"]*"|\u201c[^\u201d]*\u201d/g;
const withoutQuotes = (sentence: string) => sentence.replace(QUOTED, (m) => (m.startsWith("`") ? m : ""));
// A quote is held whole while a unit is split into sentences: a quoted sentence's own full stop ends no sentence of the reviewer's.
const QUOTE_HELD = /\uE000(\d+)\uE000/g;
// The sentences of a message, read as a person would: a tag's content (`<ungated>`, `<changelog>`) and a
// fenced block are no prose, a heading is no sentence, a list item is a unit of its own, and a paragraph's
// wrapped lines join. Each sentence keeps the unit it came from, for the context a gap sentence needs.
const sentencesOf = (text: string): { text: string; unit: number }[] => {
  const prose = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, "").replace(/<(\w+)>[\s\S]*?<\/\1>/g, "");
  const units: string[] = [];
  let open = false;
  for (const raw of prose.split("\n")) {
    let line = raw.replace(/^[ \t]*>+[ \t]?/, "").trim();
    const bold = boldLine(line);
    if (bold && !bold.label) line = bold.prose;
    if (!line || MD_HEADING.test(line) || bold?.label) open = false;
    else if (open && !/^(?:[-*+•]|\d+[.)])\s/.test(line)) units[units.length - 1] += ` ${line}`;
    else {
      units.push(line);
      open = true;
    }
  }
  return units.flatMap((u, unit) => {
    const quotes: string[] = [];
    return u
      .replace(QUOTED, (m) => (m.startsWith("`") ? m : `\uE000${quotes.push(m) - 1}\uE000`))
      .split(/(?<=[.!?])\s+(?=[A-Z"`(*\uE000])/)
      .map((s) => s.replace(QUOTE_HELD, (_, i: string) => quotes[Number(i)]).replace(/^(?:[-*+•]|\d+[.)])\s+/, "").trim())
      .map((s) => ({ text: s, unit }));
  });
};
// A sentence that points back at the one before it ("That is a coverage gap ..."): quoted alone, the person
// has to open the review log to learn what "That" is.
const ANAPHOR = /^(?:That|This|It|These|Those|Which)\b/;
// The gap sentences of a reviewer's final message, when it filed none: a message with a `<followup>` or an
// `<unmet>` line has said it the way the kit reads. Several sentences are one note. A gap sentence that opens
// with an anaphor brings the sentences before it in its paragraph, as many as fit under UNGATED_MAX (the
// nearest first), because what it points at is one of them.
const gapOf = (text: string): string | undefined => {
  if (followUpsOf(text).length || unmetOf(text)) return undefined;
  const all = sentencesOf(text);
  const take = new Set<number>();
  all.forEach((s, i) => {
    if (!isGap(withoutCode(withoutQuotes(s.text)))) return;
    take.add(i);
    if (!ANAPHOR.test(s.text)) return;
    let size = s.text.length;
    for (let j = i - 1; j >= 0 && all[j].unit === s.unit && size + all[j].text.length < UNGATED_MAX; j--) {
      take.add(j);
      size += all[j].text.length + 1;
    }
  });
  const said = [...take].sort((x, y) => x - y).map((i) => all[i].text);
  return said.length ? cutAtWord([...new Set(said)].join(" "), UNGATED_MAX) : undefined;
};
// The phase a pass's name says, in the words a person reads in the filed ticket.
const phaseOf = (name: string) =>
  name.startsWith("impl-") ? "implement" : name.startsWith("review-codex-") ? "cross-review" : name.startsWith("review-") ? "review" : name.split("-")[0];
// One problem named by two agents, or twice by one, is one ticket.
const titleKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();
// A `path:line` an agent names: the other way two passes of one ticket (implement, review) say the same
// finding in different words. A path is `dir/file.ext` or `file.ext`; whether it is a place is up to the
// base tree (`exists`), so `api.example.com:443` is not one and a root-level `status.sh:40` is.
const PLACE = /(?<![\w@.:/-])((?:[\w@.-]+\/)*[\w@-]+(?:\.[\w-]*[A-Za-z][\w-]*)+):(\d+)/g;
// A path with no line behind it (`in site/js/status.js`, `(status.sh)`).
const FILE_ONLY = /(?<![\w@.:/-])((?:[\w@.-]+\/)*[\w@-]+(?:\.[\w-]*[A-Za-z][\w-]*)+)(?![\w@/-]|:\d|\.\w)/g;
// Words that say nothing of what a finding is about: two titles share a finding by what remains.
const STOPWORDS = new Set(
  ("about after again also because before being between could does doing done each either else from have here into just like make more most much must never only other over same should since some still such than that their them then there these they this those through under until very were what when where which while will with without would your").split(" "),
);
// The significant words of a title: 4 letters or more, no stopword, and not any path the title names.
const significantWords = (title: string, paths: readonly string[]): Set<string> =>
  new Set(
    [...paths].sort((x, y) => y.length - x.length).reduce((t, p) => t.split(p).join(" "), title).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
/** One file a finding names: its line when it gave one, and `firm` when that is a `path:line` of the title. */
type Spot = { path: string; line?: number; firm: boolean };
/** Where a finding is: the source ticket's files it names (none: a path-less finding), and its title's words. */
type Seat = { from: string; spots: Spot[]; words: Set<string>; key: string };
/** What `placeSeat` asks of the base tree: is this path a file there? A host such as `api.example.com` is not. */
export type PathExists = (path: string) => boolean;
/** The base tree's one file of a bare name (`client.ts`), when exactly one has it: undefined for none or several. */
export type NamedOnBase = (name: string) => string | undefined;
const cleanPath = (p: string) => p.replace(/^(?:\.\/)+/, "");
// Every match of `re` in `text` that is a file of the base tree: by its path, or - a bare name with no `/`, not a
// file at the root - as the one file of the tree that has the name (`named`). `whole` is the text it was written as.
const filesIn = (re: RegExp, text: string, exists: PathExists, named?: NamedOnBase) => {
  const found: { path: string; line?: number; whole: string }[] = [];
  for (const m of text.matchAll(re)) {
    const given = cleanPath(m[1]);
    const path = exists(given) ? given : given.includes("/") ? undefined : named?.(given);
    if (path) found.push({ path, line: m[2] === undefined ? undefined : Number(m[2]), whole: m[1] });
  }
  return found;
};
// Every file a finding names counts, the title's first, then the evidence's: a `path:line` in the title is used as
// it is (`firm`). A place found only in the evidence, or a file with no line, counts only beside a title that
// shares significant words (`sameFinding`): the evidence often cites a line another finding is about, and two titles
// that name a file say little by it. A file is one place however often it is named; the first wording stands, and
// a line only a later one gives completes it. A finding that names no file of the base tree gets a seat with no
// spots, which `sameFinding` matches on its title alone.
const placeSeat = (f: FollowUp, exists: PathExists, named?: NamedOnBase): Seat => {
  const spots = new Map<string, Spot>();
  const wholes: string[] = [];
  const add = (at: { path: string; line?: number; whole: string }, firm: boolean, inTitle: boolean) => {
    if (inTitle) wholes.push(at.whole);
    const had = spots.get(at.path);
    if (!had) spots.set(at.path, { path: at.path, line: at.line, firm });
    else if (had.line === undefined && at.line !== undefined) had.line = at.line;
  };
  for (const at of filesIn(PLACE, f.title, exists, named)) add(at, true, true);
  for (const at of filesIn(FILE_ONLY, f.title, exists, named)) add(at, false, true);
  for (const at of filesIn(PLACE, f.evidence, exists, named)) add(at, false, false);
  for (const at of filesIn(FILE_ONLY, f.evidence, exists, named)) add(at, false, false);
  return { from: f.from, spots: [...spots.values()], words: significantWords(f.title, wholes), key: titleKey(f.title) };
};
/** Whether `path` is a file of the base branch (`git cat-file`): the host's `exists` for `fileFollowUps`. */
export const onBase = (root: string, base: string): PathExists => (path) => {
  try {
    return sh("git", ["cat-file", "-t", `${base}:${path}`], root) === "blob";
  } catch {
    return false;
  }
};
/**
 * The base tree's one file of a bare name, from one `git ls-tree` of the base, taken at the first ask and kept for
 * the run: the host's `named` for `fileFollowUps`. A name two files share, or none, gives undefined.
 */
export const namedOnBase = (root: string, base: string): NamedOnBase => {
  let byName: Map<string, string[]> | undefined;
  return (name) => {
    if (!byName) {
      byName = new Map();
      try {
        for (const path of sh("git", ["ls-tree", "-r", "--name-only", "-z", base], root).split("\0")) {
          if (!path) continue;
          const key = path.slice(path.lastIndexOf("/") + 1);
          byName.set(key, [...(byName.get(key) ?? []), path]);
        }
      } catch {
        // A base that cannot be listed resolves no name, as a caller giving none does.
      }
    }
    const paths = byName.get(name);
    return paths?.length === 1 ? paths[0] : undefined;
  };
};
const WORDS_SHARED = 2;
// With no file to agree on, the titles are all there is to go by, so they must share more: the same tooling
// failure worded twice shares three, and two unrelated findings of one ticket rarely do.
const WORDS_SHARED_NO_PLACE = 3;
// Per source ticket: the same place named for another ticket is a different finding. Two findings are one when any
// place of one matches a place of the other: at one line, when either names it in its title; otherwise (or with no
// line on one side) their titles must overlap. Two findings that name no place, or only one of which names one, are one
// when their titles overlap by more: the same gap is worded twice, one wording citing the file and the other not.
const sameFinding = (a: Seat, b: Seat): boolean => {
  if (a.from !== b.from) return false;
  // The same title from the same ticket is the same finding, however few words it has: how an earlier run's filing is met.
  if (a.key === b.key) return true;
  const shared = [...a.words].filter((w) => b.words.has(w)).length;
  if (!a.spots.length || !b.spots.length) return shared >= WORDS_SHARED_NO_PLACE;
  const overlap = shared >= WORDS_SHARED;
  return a.spots.some((x) =>
    b.spots.some((y) => {
      if (x.path !== y.path) return false;
      if (x.line !== undefined && y.line !== undefined) return x.line === y.line && (x.firm || y.firm || overlap);
      return overlap;
    }),
  );
};
/** The issue (or, for a line only listed, `""`) of each file's findings, by `from` and path: what `sameFinding` is asked of. */
export type Places = Map<string, { id: string; seat: Seat }[]>;
// A seat is kept under each file it names (a path-less one under none), so a finding meets those of any of its files;
// and under its title, so an earlier run's filing, placed by its title alone, meets the same title whatever its evidence names.
const placesKeys = (s: Seat) => [...(s.spots.length ? s.spots.map((p) => `${s.from}\0${p.path}`) : [`${s.from}\0`]), `${s.from}\0\0${s.key}`];
// A seat that names a file also meets the path-less ones, and a path-less seat meets those of every file: `sameFinding`
// matches the two on their titles alone, so the buckets (one per file) would otherwise never be compared.
const placeOf = (places: Places, seat: Seat) => {
  const keys = seat.spots.length ? [...placesKeys(seat), `${seat.from}\0`] : [...places.keys()].filter((k) => k.startsWith(`${seat.from}\0`));
  for (const key of keys) {
    const found = places.get(key)?.find((p) => sameFinding(p.seat, seat));
    if (found) return found;
  }
  return undefined;
};
const addPlace = (places: Places, seat: Seat, id: string) => {
  // Not twice: each turn of a run seeds the earlier filings again (`createFollowUpBook`'s `earlier`).
  for (const key of placesKeys(seat)) {
    const had = places.get(key) ?? [];
    if (!had.some((p) => p.id === id && p.seat.key === seat.key)) places.set(key, [...had, { id, seat }]);
  }
};
// What was said again about an issue already filed, as the comment on it.
const repeatComment = (f: FollowUp, ref: (id: string) => string) =>
  `Named again by the ${f.phase} agent working on ${ref(f.from)}, as the same finding, worded "${f.title}":\n\n${f.evidence || "(no evidence given)"}`;
// The titles filed by every turn of this `sandcastle run`: a turn that re-runs a ticket (partly done,
// requeued) hears its agents name the same problem again, and that is still one ticket.
const filedThisRun = new Set<string>();
// The issue each place was filed as, by every turn of this run (`placeSeat`): the same finding in other words is a comment on it.
const placesThisRun: Places = new Map();

/**
 * Files each follow-up as a new ticket for triage through the project's tracker (`create`), its body
 * naming the source ticket and phase, a title already filed in this run once. A follow-up naming the
 * same place as one already filed for the same source ticket (`placeSeat`), whatever its title, or sharing three
 * significant words of its title with one when either of the two names no place, is not filed:
 * its evidence is a comment on that issue (`places` holds the issue of each place) and it is not
 * returned, unless the comment fails. A dry run files nothing and returns them unfiled, for the summary to list.
 * `write` is how a tracker write is made (the host's git mutex in a run: a ticket file is a commit on
 * the base). `seen` is the titles already filed, shared by a run's turns. A failed filing is kept with
 * its reason, never thrown, and its title left unseen for a later turn to file: the run's landings stand.
 */
export const fileFollowUps = async (
  tracker: Pick<Tracker, "create" | "ref" | "comment">,
  followUps: readonly FollowUp[],
  o: { dryRun: boolean; write: (fn: () => string) => Promise<string>; seen?: Set<string>; places?: Places; exists: PathExists; named?: NamedOnBase },
): Promise<FiledFollowUp[]> => {
  const seen = o.seen ?? new Set<string>();
  const places = o.places ?? new Map();
  const out: FiledFollowUp[] = [];
  for (const f of followUps) {
    const key = titleKey(f.title);
    if (seen.has(key)) continue;
    const at = { title: f.title, from: f.from, phase: f.phase };
    const place = placeSeat(f, o.exists, o.named);
    const first = o.dryRun ? undefined : placeOf(places, place)?.id;
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
      addPlace(places, place, id);
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
 * the same source ticket (`placeSeat`) is not listed: it is held until that one is filed, and then
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
  /** What is named already from one ticket, for its agents' prompts: earlier runs' filings, then this run's lines (`alreadyNamedView`). */
  namedFrom(from: string): NamedFollowUp[];
  /** What this run's passes named from every ticket but one, for that ticket's agents' prompts (`runTicketsView`). Earlier runs' filings are left out: they are another run's. */
  namedByOthers(from: string): NamedFollowUp[];
};
/** A follow-up named from a ticket already: `id` is the issue it was filed as, absent while this run has yet to file it; `phase` the pass of this run that named it; `from` the ticket whose agent named it, in `namedByOthers`. */
export type NamedFollowUp = { title: string; id?: string; phase?: string; from?: string };
export const createFollowUpBook = (
  run: { update(fields: { followUps: FiledFollowUp[] }): void },
  o: {
    tracker: Pick<Tracker, "create" | "ref" | "comment">;
    dryRun: boolean;
    write: (fn: () => string) => Promise<string>;
    seen?: Set<string>;
    places?: Places;
    exists: PathExists;
    named?: NamedOnBase;
    /** What earlier runs filed (`filedBefore`): the same finding named again is a comment on that issue, as a repeat within a run is. */
    earlier?: readonly FiledFollowUp[];
  },
): FollowUpBook => {
  const seen = o.seen ?? new Set<string>();
  const places = o.places ?? new Map();
  // Without the evidence the record never kept, a filing is met by its title: the same one, or a match under the place rules.
  for (const e of o.earlier ?? []) if (e.id !== undefined) addPlace(places, placeSeat({ title: e.title, evidence: "", from: e.from, phase: e.phase }, o.exists, o.named), e.id);
  const heard: FollowUp[] = [];
  // The same finding as a listed one, in other words: comments on its issue once there is one.
  let repeats: FollowUp[] = [];
  const listedPlaces: Places = new Map();
  // By title, in the order the lines arrived: what the run record's `followUps` holds.
  const listed = new Map<string, FiledFollowUp>();
  const keep = () => run.update({ followUps: [...listed.values()] });
  return {
    push(f) {
      const key = titleKey(f.title);
      if (seen.has(key)) return;
      if (!listed.has(key)) {
        const place = placeSeat(f, o.exists, o.named);
        if (placeOf(listedPlaces, place) || placeOf(places, place)) {
          repeats.push(f);
          return;
        }
        addPlace(listedPlaces, place, "");
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
        exists: o.exists,
        named: o.named,
      });
      if (settled.length) {
        for (const s of settled) listed.set(titleKey(s.title), s);
        keep();
      }
      if (!o.dryRun && !refuse) {
        repeats = repeats.filter((f) => !seen.has(titleKey(f.title)));
        const ready = repeats.filter((f) => placeOf(places, placeSeat(f, o.exists, o.named)));
        // A comment that fails is not recorded: it stays held, and the next `file` tries it again.
        if (ready.length) await fileFollowUps(o.tracker, ready, { dryRun: false, write: o.write, seen, places, exists: o.exists, named: o.named });
        repeats = repeats.filter((f) => !seen.has(titleKey(f.title)));
      }
      if (!settled.length) return [];
      return [...new Set(settled.map((s) => titleKey(s.title)))].map((key) => listed.get(key)!);
    },
    namedFrom(from) {
      const out = new Map<string, NamedFollowUp>();
      for (const e of o.earlier ?? []) if (e.from === from && e.id !== undefined && !out.has(titleKey(e.title))) out.set(titleKey(e.title), { title: e.title, id: e.id });
      for (const l of listed.values()) if (l.from === from) out.set(titleKey(l.title), { title: l.title, ...(l.id !== undefined ? { id: l.id } : { phase: l.phase }) });
      return [...out.values()];
    },
    namedByOthers(from) {
      return [...listed.values()].filter((l) => l.from !== from).map((l) => ({ title: l.title, from: l.from, ...(l.id !== undefined ? { id: l.id } : { phase: l.phase }) }));
    },
  };
};

/**
 * The follow-ups an agent is shown as already named from its ticket (`FOLLOWUPS_NAMED`): each with the issue it was
 * filed as, or, when this run has yet to file it, the pass that named it. A review never saw the implementer's
 * lines, and a later run never knew what an earlier one filed, so each restated the problem in other words.
 * Empty when there are none, so the prompt carries no heading over nothing.
 */
export const alreadyNamedView = (named: readonly NamedFollowUp[], ref: (id: string) => string): string =>
  named.length
    ? "# Follow-ups already named from this ticket\n\nThese problems outside this ticket are filed already, or will be when this run lands. " +
      "Do not give a `<followup>` line for any of them again, in any wording; a problem not on this list gets its own line.\n\n" +
      named.map((n) => (n.id !== undefined ? `- ${ref(n.id)} ${n.title}` : `- ${n.title} (named by this ticket's ${n.phase ?? "earlier"} pass)`)).join("\n") +
      "\n\n"
    : "";

/**
 * The rest of `FOLLOWUPS_NAMED`: the run's other tickets (`others`, by ref and title) and what their agents have named
 * so far (`byOthers`), each list left out when empty. A problem one of them covers is that ticket's work or filed
 * already, and the agent judges the meaning: the kit compares nothing across tickets (`sameFinding` stays per source
 * ticket) and writes nothing to them.
 */
export const runTicketsView = (
  others: readonly { id: string; title: string }[],
  byOthers: readonly NamedFollowUp[],
  ref: (id: string) => string,
): string =>
  (others.length
    ? "# Other tickets in this run\n\nThese tickets run in this same run. A problem one of them covers is that ticket's work, not a finding of yours: " +
      "give it no `<followup>` line, in any wording.\n\n" +
      others.map((t) => `- ${ref(t.id)} ${t.title}`).join("\n") +
      "\n\n"
    : "") +
  (byOthers.length
    ? "# Named by other tickets this run\n\nThese problems were named by the agents of other tickets of this run, and are filed already or will be when this run lands. " +
      "Give no `<followup>` line for any of them, in any wording.\n\n" +
      byOthers
        .map((n) => (n.id !== undefined ? `- ${ref(n.id)} ${n.title}` : `- ${n.title} (named by ${n.from !== undefined ? ref(n.from) : "another ticket"}'s ${n.phase ?? "earlier"} pass)`))
        .join("\n") +
      "\n\n"
    : "");

/**
 * The follow-ups earlier runs filed (an issue id on the entry), from the project's `logs/history.jsonl`, read as
 * `changelogSince` reads it: a line that does not parse is skipped, and so is a dry run's. Only the tickets in `from`
 * when given. A ticket's follow-up filed in two runs (one the earlier missed) is listed twice. An issue that is closed
 * (`isClosed`; one it cannot tell stays) is left out: a new problem in the same file is not a comment on a closed issue.
 */
export const filedBefore = (root: string, from?: ReadonlySet<string>, isClosed?: (id: string) => boolean | undefined): FiledFollowUp[] => {
  const file = join(root, ".sandcastle/logs/history.jsonl");
  if (!existsSync(file)) return [];
  const out: FiledFollowUp[] = [];
  const closed = new Map<string, boolean>();
  const gone = (id: string) => {
    if (!isClosed) return false;
    if (!closed.has(id)) closed.set(id, isClosed(id) === true);
    return closed.get(id)!;
  };
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (!text.includes('"followUps"')) continue;
    try {
      const run = JSON.parse(text);
      if (!Array.isArray(run?.followUps) || run.dryRun) continue;
      for (const f of run.followUps) {
        if (typeof f?.title === "string" && typeof f.from === "string" && typeof f.phase === "string" && (typeof f.id === "string" || typeof f.id === "number") && (!from || from.has(f.from)) && !gone(String(f.id))) {
          out.push({ title: f.title, from: f.from, phase: f.phase, id: String(f.id) });
        }
      }
    } catch {
      /* a line that does not parse is skipped */
    }
  }
  return out;
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

/**
 * The tickets a turn runs plus the rest of the queue: a named ticket not queued (hand-picked) stays, as it was.
 * `scope` is the operator's own list (the ids `sandcastle run 12 15` named, carried across every turn): the
 * queue then adds only tickets inside it, so a ticket the operator left out is never listed, recorded or reported.
 */
export const wholeQueue = (tracker: Tracker, named: Issue[], scope?: ReadonlySet<string>): Issue[] => [
  ...named,
  ...tracker.queued(false).filter((t) => !named.some((n) => n.id === t.id) && (!scope || scope.has(t.id))),
];

/**
 * The operator's named list as ticket ids, for `wholeQueue`'s `scope`. A ticket the tracker cannot read
 * keeps the id as typed: a later turn must not throw on a ticket closed or removed since the first.
 */
export const scopeIds = (tracker: Tracker, list: string, known: Issue[] = []): Set<string> =>
  new Set(
    list.split(",").map((n) => {
      const typed = n.trim();
      const hit = known.find((t) => t.id === typed);
      if (hit) return hit.id;
      try {
        return tracker.get(typed).id;
      } catch {
        return typed;
      }
    }),
  );

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
 * A branch that merged a base since rewritten (`staleBaseParents`) has no merge base to count from:
 * the three dots would list everything the rewrite moved, so it is the files its own commits changed
 * (the pipeline re-creates it from those commits).
 */
export const branchFiles = (root: string, base: string, id: string): string[] => {
  try {
    const branch = `agent/issue-${id}`;
    sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
    if (staleBaseParents(base, branch, root).length) {
      return [...new Set(sh("git", ["log", "--no-merges", "--no-renames", "--name-only", "--format=", "-z", ...ownRange(base, branch, root)], root).split("\0").filter(Boolean))];
    }
    return sh("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...${branch}`], root).split("\0").filter(Boolean);
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
 * what they say is the run's: `share` is told each time what holds a wait back changes - `held` is whether the run's
 * share or the slot kept for landing does (the run record's `waitsForShare`, which an older view reads), `waitsFor`
 * which of the two (`waitsFor`; the share wins while waits of both kinds are open) - and `since` is when the oldest
 * wait still open began (the heartbeat). Each wait `begin`s as it asks the pool, hands the pool's reason to `onWait`,
 * and `end`s as it is served or given up.
 */
export const createSlotWaits = (share: (held: boolean, waitsFor?: "share" | "landing") => void, now: () => number = Date.now) => {
  const open = new Map<object, { since: number; why?: "share" | "landing" }>();
  let told: "share" | "landing" | undefined;
  const tell = () => {
    const whys = [...open.values()].map((w) => w.why);
    const waitsFor = whys.includes("share") ? "share" : whys.includes("landing") ? "landing" : undefined;
    if (waitsFor === told) return;
    told = waitsFor;
    share(waitsFor !== undefined, waitsFor);
  };
  return {
    begin() {
      const key = {};
      open.set(key, { since: now() });
      return {
        onWait(why: WaitReason) {
          const wait = open.get(key);
          if (!wait) return;
          wait.why = why === "share" || why === "landing" ? why : undefined;
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
export const createHoldRecord = (o: {
  waiting: { issue: string; on: string[] }[];
  ref(id: string): string;
  say(line: string): void;
  log?(line: string): void;
  /** Tickets whose hold the start plan's ticket list already says: `start` records them but does not say them a second time. */
  listed?: ReadonlySet<string>;
}) => {
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
  // A release says only the file lines not said yet this run: the start's block was repeated at every release.
  const said = new Set<string>();
  const sayShares = (pairs: { id: string; share: FileShare }[]) => {
    const lines = fileShareSummary(o.ref, pairs);
    if (!lines.length) return;
    const fresh = lines.filter((line) => !said.has(line));
    if (fresh.length) {
      o.say(said.size ? "  more tickets that share files:" : "  tickets that share files; if they conflict at landing, the later one is sent back once and its merge resolved:");
      for (const line of fresh) {
        said.add(line);
        o.say(`    ${line}`);
      }
    }
    for (const { id, share } of pairs) o.log?.(fileShareLine(o.ref, id, share));
  };
  return {
    start(candidates: readonly Start<{ id: string }>[]) {
      const pairs: { id: string; share: FileShare }[] = [];
      for (const { ticket, file, shares } of candidates) {
        if (file) {
          o.waiting.push({ issue: ticket.id, on: [o.ref(file.with)] });
          if (!o.listed?.has(ticket.id)) o.say(`  ${o.ref(ticket.id)} ${fileWaitNote(o.ref, file)}`);
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
          o.say(`  ${o.ref(c.id)} ${c.after.kind === "blockers" ? "released: its last blocker has landed; it starts at the next free slot" : `released: ${o.ref(c.after.freed)} is done with the file they both change; it starts at the next free slot`}`);
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
  /**
   * The gates from the one named on (`from`) - that one, then each after it in config order - in the ticket's sandbox:
   * what an attempt's first red gets before any repair pass, in case it was only the machine being busy. A pipeline
   * given none repairs at once.
   */
  regate?: (box: PipelineBox, id: string, from: string) => Promise<GateRun>;
  /** Every gate on the base's tip, in a sandbox of its own (`gateBase`): what a failure no branch caused is checked against. `issue` is the ticket whose red asked. */
  baseGate: (issue: string) => Promise<GateRun>;
  /**
   * Whether the green-base record holds the base's tip now: the gates passed on it already, so a red is not the base's
   * and no run is made to find out. A pipeline given none runs the base gates as it did.
   */
  baseRecordedGreen?: () => boolean;
  /** Tests found red on the base mid-run, told once each: the run record keeps them for the closing summary. */
  baseWentRed: (tests: string[]) => void;
  timed: Timed;
  run: { ticket(id: string, fields: TicketRecord): void };
  view: Pick<SandboxView, "claim">;
  host: Pick<HostGit, "begin" | "settle"> & Partial<Pick<HostGit, "write" | "check">>;
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
  followUps?: { push(f: FollowUp): unknown; namedFrom?(from: string): NamedFollowUp[]; namedByOthers?(from: string): NamedFollowUp[] };
  /** The tickets this turn may run (`burndown()`'s `candidates`): each agent is shown the others by ref and title (`runTicketsView`). None, and it is shown none. */
  tickets?: readonly { id: string; title: string }[];
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

/**
 * The worktree under the project's `.sandcastle/worktrees/` that has `branch` checked out, as the kit's sandboxes
 * keep theirs; none for a branch no worktree holds, or one a person's own worktree holds elsewhere. Git lists the
 * real path of a worktree, so the directory is compared under the root and under its realpath (as a project under
 * macOS's `/tmp` needs).
 */
const keptWorktreeOf = (project: Project, branch: string): string | undefined => kitWorktrees(project).find((w) => w.branch === branch)?.path;

/**
 * Every worktree git lists under the project's `.sandcastle/worktrees/`, with the branch it has checked out ("" for none).
 * Not one whose directory is gone (a person removed it): no git runs there, Sandcastle's open prunes its record, and
 * its record check would read the missing `.git` file as tampering.
 */
const kitWorktrees = (project: Project): { path: string; branch: string }[] => {
  const under = [...new Set([project.root, realpathSync(project.root)])].map((r) => join(r, ".sandcastle", "worktrees") + sep);
  return sh("git", ["worktree", "list", "--porcelain"], project.root)
    .split("\n\n")
    .flatMap((entry) => {
      const lines = entry.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      const branch = lines.find((l) => l.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? "";
      return path && under.some((u) => resolve(path).startsWith(u)) && existsSync(path) ? [{ path, branch }] : [];
    });
};

/**
 * The kit's worktrees Sandcastle's open would reuse for `branch`, as it finds them: the one that has the branch checked
 * out, and the one at the branch's own path (`agent-issue-<n>`) whatever it has checked out.
 */
const reusedWorktrees = (project: Project, branch: string): string[] =>
  kitWorktrees(project)
    .filter((w) => w.branch === branch || basename(w.path) === branch.replace(/\//g, "-"))
    .map((w) => w.path);

/**
 * True when nothing in the worktree is uncommitted or untracked (what Sandcastle's close keeps a worktree for), so
 * a move of its checkout loses nothing. Asked of git with the options a config could turn off; a worktree git
 * cannot read (gone, its record rewritten) is not clean. Submodules are never looked into: recursing runs the status
 * in a repository the sandbox nested in its worktree, with that repository's own config and filters, on the host -
 * and only the command-line flag holds, as a `.gitmodules` the sandbox wrote can set `ignore = none`.
 */
const worktreeIsClean = (project: Project, path: string) => {
  try {
    return sh("git", ["-C", path, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=all"], project.root) === "";
  } catch {
    return false;
  }
};

/** One ticket's pipeline: implement, review, gate with repair, in its own sandbox. */
export const createPipeline = (ctx: PipelineContext) => {
  const { project, tracker, runId, dryRun, repair, testRedGate, prompts, overrides, open, gate, baseGate, baseRecordedGreen, baseWentRed, timed, run, view, host, requeuedAs, results, reds, reports, notes, took, keptWorktrees, tampered } = ctx;
  const fixes = ctx.fixes ?? createFixBoard();
  const waited = ctx.waited ?? new Map<string, number>();
  const landed = ctx.landed ?? new Map<string, { files: string[]; commit: string }>();
  const base = project.baseBranch;
  const ref = tracker.ref;
  /**
   * The records of a kit worktree the host is about to run git in, held to git's own (`assertWorktreeRecords`). A
   * failure is the ticket's `tampered`, which stops the run as a failed `.git` check does, and is thrown.
   */
  const checkRecords = (issue: string, path: string, when: string) => {
    try {
      assertWorktreeRecords(project, path, when);
    } catch (error) {
      tampered.set(issue, error);
      throw error;
    }
  };
  /** The run's `.git` check (`host.check`) before a ticket's sandbox opens. A failure is the ticket's `tampered`, as above, and is thrown. */
  const checkGit = async (issue: string, when: string) => {
    try {
      await host.check?.(when);
    } catch (error) {
      tampered.set(issue, error);
      throw error;
    }
  };

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

  /**
   * A branch an earlier run left with no commit ahead of the base (a crashed attempt, a remainder whose work already
   * merged) is cut from the base's tip again, before its sandbox opens. Sandcastle checks an existing branch out as it
   * stands and the base merge in the attempt's setup is for a carried branch only, so the agent would work - count
   * tests, conflict at landing - on the tree of the run that left it. Nothing is lost: with none ahead, every commit
   * of the branch is already the base's. A branch with commits keeps its fork point (the sandbox merges the base in).
   * It runs through the host git's one writer, after `host.begin` so the `.git` check reads the new tip as the
   * pipeline's own move. A branch a worktree still holds cannot be moved (git refuses), and Sandcastle reuses that
   * worktree as it stands - the worktree a run killed before its sandboxes closed leaves. Such a worktree under
   * `.sandcastle/worktrees/` with nothing uncommitted is moved with its branch (a fast-forward: none ahead, so git
   * refuses rather than lose anything), keeping its installed dependencies; one with uncommitted or untracked
   * files, or a person's own elsewhere, is left where it is; so is one holding an ignored file the base now tracks.
   * A sandbox wrote that worktree's records, so they are held to git's own before the host runs git in it
   * (`checkRecords`): a changed one stops the run instead.
   */
  const cutFromBase = (issue: string, branch: string) => {
    const cut = () => {
      let ahead: number;
      let behind: number;
      try {
        ahead = Number(sh("git", ["rev-list", "--count", `refs/heads/${base}..refs/heads/${branch}`], project.root));
        behind = Number(sh("git", ["rev-list", "--count", `refs/heads/${branch}..refs/heads/${base}`], project.root));
      } catch {
        return; // no such branch: the sandbox cuts a new one from the base
      }
      if (ahead > 0 || behind === 0) return;
      const was = `${ref(issue)}: ${branch} had no commits ahead of ${base} and was ${behind} commit(s) behind it`;
      try {
        const kept = keptWorktreeOf(project, branch);
        // The status and the merge are host git commands in a worktree a sandbox (an earlier run's) wrote: its records
        // are held to git's own first, and a failure stops the run.
        if (kept) checkRecords(issue, kept, `before moving ${branch} in ${keptPath(project.root, kept)}`);
        if (kept && worktreeIsClean(project, kept)) {
          // worktreeIsClean leaves ignored files out; --no-overwrite-ignore makes git refuse, not overwrite, one the base now tracks.
          sh("git", ["-C", kept, "merge", "--ff-only", "--no-overwrite-ignore", `refs/heads/${base}`], project.root);
          console.log(`${was} - cut again from ${base}'s tip in its kept worktree.`);
        } else {
          // No worktree holds it, or one that is not clean or not the kit's does: git moves the branch, or refuses to.
          sh("git", ["branch", "-f", branch, `refs/heads/${base}`], project.root);
          console.log(`${was} - cut again from ${base}'s tip.`);
        }
      } catch (error) {
        if (error instanceof GuardStop) throw error;
        console.log(`${was}, but could not be cut again from ${base}'s tip (${errorLine(error)}); its sandbox opens on the old tree.`);
      }
    };
    return host.write ? host.write(cut) : cut();
  };

  const addReport = (id: string, heading: string, text: string) =>
    reports.set(id, [reports.get(id), `**${heading}**\n\n${text}`].filter(Boolean).join("\n\n"));

  // A later run skips work a branch already passed (see recordHead). A dry run's
  // work must not change what a real run skips, and a failed write never fails
  // the ticket: the cost is only that a re-run runs it in full.
  const noteHead = (id: string, branch: string, fields: { reviewed?: string; green?: string; red?: string; unmet?: string; implSaid?: string; gates?: Gate[]; changelog?: string[]; changelogDropped?: number; changelogDroppedWhy?: string[]; changelogNone?: boolean; ungated?: string; gap?: string; repaired?: string[] }) => {
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
  const redOnBase = async (failure: { name: string; output: string }, branch: string, issueId: string): Promise<string[] | undefined> => {
    const tests = failingTests(failure.output);
    if (!tests.length || tests.length >= FAILING_TESTS_SHOWN) return undefined;
    const files = tests.map(failingTestFile);
    if (files.some((f) => f === undefined)) return undefined;
    // Against the merge base: a branch that merged the base in has not changed what the base did.
    const changed = new Set(sh("git", ["diff", "--no-renames", "--name-only", `${base}...${branch}`], project.root).split("\n").filter(Boolean));
    if (files.some((f) => changed.has(f!))) return undefined;
    const tip = sh("git", ["rev-parse", base], project.root);
    let running = baseRuns.get(tip);
    // A tip the landing gates (or the base check) passed has no red of its own to find: waiting for the machine's
    // one gates slot to learn that put the repair back by minutes. A run already made for it keeps its answer.
    if (!running && baseRecordedGreen?.()) return undefined;
    if (!running) {
      const asked = baseGate(issueId);
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
    // A run that could not be made is no answer, but a failed `.git` check before its sandbox closed stops the run.
    const onBase = await running.then(
      (r) => r.failures.find((f) => f.name === failure.name),
      (error) => {
        if (error instanceof GuardStop) throw error;
        return undefined;
      },
    );
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
    } catch (error) {
      // Objects a partial clone lacks: said once and kept for the closing summary, not read as a merge that is clean.
      noteMissingObjects(project.root, error);
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
    // `IMPL_UNMET`, `IMPL_SAID` and `IMPL_CHANGELOG` are empty here: only a full review is shown the implementer's
    // unmet line, closing paragraph and changelog lines (see `implUnmetView`, `implSaidView`, `implChangelogView`).
    // `FOLLOWUPS_NAMED` is empty here too, and filled at every agent pass (`pass`) from the run's follow-up book.
    const promptArgs = { ISSUE_NUMBER: issue.id, TICKET: ref(issue.id), IMPL_UNMET: "", IMPL_SAID: "", IMPL_CHANGELOG: "", FOLLOWUPS_NAMED: "", ...tracker.promptArgs(issue.id) };
    const merge = mergedEarlier(issue.id, branch);
    if (merge) {
      return { issue: issue.id, branch, status: "merged-earlier", commits: 0, reviewCommits: 0, repairs: 0, gates: [], head: merge };
    }
    view.claim(issue.id, issue.title);

    // Sandcastle's open runs host git in the project: `git worktree add`, whose checkout writes every file through the
    // filters `.git/config` names, or in a kit worktree it reuses (one that holds the branch or sits at its path)
    // `git status` (its origin refresh is patched out, #711). The pins hold only the filters configured at the start, so a
    // filter another sandbox planted since the last check would run on the host. A reused worktree - one kept from an
    // earlier run, or from before a pause - has its records held to git's own, then the run's `.git` check comes, the
    // last thing before every open, the first and a resume's. A failure stops the run before the sandbox opens.
    const openChecked = async (when: string) => {
      for (const kept of reusedWorktrees(project, branch)) checkRecords(issue.id, kept, `before reusing ${keptPath(project.root, kept)}`);
      await checkGit(issue.id, when);
      return open(branch);
    };

    const started = Date.now();
    releaseBranchWorktree(branch, project.root);
    // From here the agent commits to the branch, and the setup may cut it from the base again: the `.git` check lets it move.
    host.begin(branch);
    // Reassigned when a pause closes the sandbox and the resume opens another on the same branch.
    let sandbox = await timed(
      issue.id,
      "setup",
      async () => {
        await cutFromBase(issue.id, branch);
        return openChecked(`before opening ${ref(issue.id)}'s sandbox`);
      },
      requeuedAs.get(issue.id),
      undefined,
      at?.resolveWaitMs,
    ).catch(async (error) => {
      // The cut goes through the host's one writer, whose `.git` check comes first: a change it finds, made before the
      // setup began, stops the run as the open's own check would, not only this ticket.
      if (error instanceof GuardStop && !tampered.has(issue.id)) tampered.set(issue.id, error);
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
    const pass = async (given: Parameters<typeof sandbox.run>[0]) => {
      agentsRan = true;
      // What the ticket's earlier passes and earlier runs named, as of this pass: the review sees the implementer's lines.
      const opts = given.promptArgs && "FOLLOWUPS_NAMED" in given.promptArgs
        ? { ...given, promptArgs: { ...given.promptArgs, FOLLOWUPS_NAMED: alreadyNamedView(ctx.followUps?.namedFrom?.(issue.id) ?? [], ref) + runTicketsView(ctx.tickets?.filter((t) => t.id !== issue.id) ?? [], ctx.followUps?.namedByOthers?.(issue.id) ?? [], ref) } }
        : given;
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
          logExpansionFailure(opts.logging, error);
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
    // The sandbox's container was removed without Sandcastle's close, after a failed check: nothing is left to close.
    let removed = false;
    // Sandcastle's close runs `git status` on the host in the worktree: before it, the container is stopped and the
    // `.git` check (`check`) and the worktree's records are made (`checkBeforeClose`). A failure is the ticket's
    // `tampered` (the first one stands), which stops the run; the container is then removed without that close, the
    // worktree left as it stands (locked until the run exits, as every worktree the kit locked), and nothing is
    // returned.
    const closeSandbox = async (when: string, check: () => unknown) => {
      await settleAfter(
        () => checkBeforeClose(project, sandbox.worktreePath, when, check),
        (error) => {
          removed = true;
          if (!tampered.has(issue.id)) tampered.set(issue.id, error);
        },
      );
      if (removed) return undefined;
      unlockWorktree(sandbox.worktreePath, project.root);
      return sandbox.close();
    };
    const juncture = (phase: TicketState, inPass = false) =>
      at?.juncture(phase, {
        suspend: async () => {
          const head = sh("git", ["rev-parse", "--short", branch], project.root);
          console.log(`${ref(issue.id)}: paused before ${phase} - its sandbox closes, ${branch} stays at ${head}`);
          run.ticket(issue.id, { state: "paused", note: `before ${phase} at ${head}` });
          await recordPeak(sandbox, project.root, runId);
          const when = `before closing ${ref(issue.id)}'s sandbox for the pause`;
          const closed = await closeSandbox(when, () => host.check?.(when));
          // The check failed: the ticket parks no more, and its attempt stops the run with it.
          if (removed) throw tampered.get(issue.id);
          if (closed?.preservedWorktreePath) lockWorktree(closed.preservedWorktreePath, project.root);
          parkedAt = Date.now();
          parkCount++;
          closedWhileParked = true;
        },
        resume: async () => {
          const parked = Date.now() - parkedAt;
          if (inPass) parkedInStep += parked;
          else waited.set(issue.id, (waited.get(issue.id) ?? 0) + parked);
          releaseBranchWorktree(branch, project.root);
          sandbox = await timed(issue.id, "setup", () => openChecked(`before reopening ${ref(issue.id)}'s sandbox after the pause`), `resumed before ${phase}`);
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
        return { issue: issue.id, branch, status: "conflict", conflict: { ...conflict, found: before }, commits: ownCommits(base, branch, project.root), gates: [], head: sh("git", ["rev-parse", branch], project.root), ...o };
      };
      // A branch that merged a base since rewritten (a `pull --rebase` that flattened the landing merges into copies,
      // a reset that dropped a landing) holds commits the base no longer has under their old hashes: landed as it
      // stands it brings them back, duplicated or removed on purpose, with no review, and its recorded heads vouch
      // for them. It is re-created on the base's tip from its own commits, in the sandbox as the merge below is, and
      // its head record dropped, so the full implement, review and gates follow. A commit that does not apply holds
      // it for a person, the branch as it was. Before `carried` and the head records below read the branch.
      const rebuilt = await rebuildOnBase(sandbox, { root: project.root, base, branch, identity: hostIdentity(project.root) }).catch((error) => {
        if (error instanceof GuardStop) throw error;
        console.log(`${ref(issue.id)}: could not tell whether ${base} was rewritten under ${branch} (${errorLine(error)}); it runs as a carried branch does.`);
        return undefined;
      });
      if (rebuilt?.kind === "held") {
        const why = rewrittenNote(base, rebuilt);
        console.log(`${ref(issue.id)}: ${why} - held for a human.`);
        notes.push({ issue: issue.id, kind: "hold", text: `Sandcastle held this: ${why}.` });
        return heldResolution(issue.id, branch, why, { commits: ownCommits(base, branch, project.root), reviewCommits: 0, gates: [] });
      }
      if (rebuilt) {
        console.log(rebuiltLine(ref(issue.id), base, rebuilt));
        run.ticket(issue.id, { note: `re-created on the rewritten ${base}` });
        // A dry run's work must not change what a real run skips; the old record stands for the old tip, which the rebuilt branch no longer holds.
        if (!dryRun) forgetHead(project.root, issue.id);
      }
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
      // The cleanly merged files the resolver said it had to change, and why (`strayNamesOf`).
      let resolverSaid: NamedStray[] = [];
      // The stray changes among them that `strayChanges` found, which the narrow review is shown.
      let namedStrays: NamedStray[] = [];
      if (landOnly && mergeConflicted) {
        await juncture("resolve");
        const resolver = await timed(issue.id, "resolve", () => {
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
        resolverSaid = strayNamesOf(resolver?.stdout ?? "");
        if ((await sandbox.exec("git rev-parse -q --verify MERGE_HEAD")).exitCode === 0) {
          console.log(`${ref(issue.id)}: the merge is still unresolved - the full implement and review run.`);
          landOnly = false;
        }
      }
      if (landOnly && mergeConflicted && greenHead !== undefined && baseTip !== undefined) {
        // A resolution may touch only what git could not merge itself: a change to another path
        // the base had changed can drop another ticket's landed lines with every gate green.
        const stray = strayChanges(project.root, { ours: greenHead, theirs: baseTip, resolved: sh("git", ["rev-parse", branch], project.root), generated: project.generated });
        // A change the resolver named, with its reason, goes on to the narrow review (which is shown it) and the gates;
        // one it did not name is held, as before.
        const { named, unnamed } = splitStrays(stray ?? [], resolverSaid);
        namedStrays = named;
        if (unnamed.length) {
          const why = strayNote(unnamed, named.map((n) => n.path));
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
        if (named.length) console.log(`${ref(issue.id)}: the resolver changed ${named.map((n) => n.path).join(", ")}, which merged cleanly, and said why - the review and the gates see it.`);
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
      const narrowReview = async (since: string, note: string, strays: NamedStray[] = []) => {
        await juncture("review");
        let narrowModel: string | undefined;
        return timed(
          issue.id,
          "review",
          () => {
            return reviewWithFallback(ref(issue.id), (agent, model) => {
              narrowModel = model;
              return reviewRun(`review-${issue.id}`, prompts.remerge, { ...promptArgs, REVIEW_BASE: since, MERGE_STRAYS: namedStraysView(strays) })(agent);
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
      // A land-only branch runs no review: what its reviewers said stands from its head record, as `unmet` does.
      const ungated: string[] = landOnly ? [readHeads(project.root)[issue.id]?.ungated ?? ""].filter(Boolean) : [];
      // What reviewers said of a gap in prose and filed nowhere (`gapOf`).
      const gaps: string[] = landOnly ? [readHeads(project.root)[issue.id]?.gap ?? ""].filter(Boolean) : [];
      // The lines of every agent's final message, only when the project asked for them. A land-only
      // branch runs no implementer or review: its lines stand from its head record, as `unmet` does.
      const changelog: string[] = landOnly ? [...(readHeads(project.root)[issue.id]?.changelog ?? [])] : [];
      const drops: ChangelogDrops = { count: landOnly ? (readHeads(project.root)[issue.id]?.changelogDropped ?? 0) : 0, why: landOnly ? [...(readHeads(project.root)[issue.id]?.changelogDroppedWhy ?? [])] : [] };
      // Whether any pass answered `none`; it counts only while no pass has given a line (see `agentsSaid`).
      let changelogSaidNone = landOnly ? !!readHeads(project.root)[issue.id]?.changelogNone : false;
      // The implementer's lines come first; a later full review that gives lines restates the branch's whole
      // set and replaces them - and the tags dropped from the set it replaced - a narrow pass adds its own
      // (see addChangelog).
      const noteChangelog = (text: string | undefined, narrow = false) => {
        if (!project.changelog || !text) return;
        if (changelogScan(text).none) changelogSaidNone = true;
        addChangelog(changelog, text, narrow, drops);
      };
      // What the agents knowingly left undone. The implementer's word stands only until a full
      // review has read the branch after it: the reviewer may have finished the criterion.
      // A land-only branch runs no implementer or review: what its agents said stands from its head record.
      let implUnmet = landOnly ? readHeads(project.root)[issue.id]?.unmet : undefined;
      // The implementer's closing paragraph, which a full review is shown (`implSaidView`); kept in the head
      // record like `unmet`, so a land-only or requeued attempt still has it.
      let implSaid = landOnly ? readHeads(project.root)[issue.id]?.implSaid : undefined;
      let reviewed = false;
      const unmet: string[] = [];
      // What the agents have said so far, as a head record keeps it: a branch stopped mid-gates is re-run
      // from its reviewed tip with no agent, and without this its criteria and changelog lines would be gone.
      const agentsSaid = () => {
        const left = reviewed ? unmet : [...(implUnmet ? [implUnmet] : []), ...unmet];
        return {
          unmet: left.length ? cutAtWord([...new Set(left)].join("; "), UNGATED_MAX) : undefined,
          implSaid,
          changelog: changelog.length ? [...new Set(changelog)] : undefined,
          changelogDropped: drops.count || undefined,
          changelogDroppedWhy: drops.why.length ? [...drops.why] : undefined,
          changelogNone: (!changelog.length && changelogSaidNone) || undefined,
          ungated: ungated.length ? cutAtWord([...new Set(ungated)].join("; "), UNGATED_MAX) : undefined,
          gap: gaps.length ? cutAtWord([...new Set(gaps)].join(" "), UNGATED_MAX) : undefined,
        };
      };
      if (landOnly && (mergeConflicted || carriedMerge) && greenHead !== undefined) {
        // The resolver finished the merge on a branch reviewed and green at greenHead, or the branch
        // carries a merge from an earlier run that no review has read: nobody has seen its
        // resolution. A clean land-only merge of the base needs no review.
        console.log(`${ref(issue.id)}: ${mergeConflicted ? "conflict resolved" : "merge carried from an earlier run"} - reviewing the resolution only.`);
        const beforeResolved = ownNow();
        const resolved = await narrowReview(greenHead, "after conflict resolution", namedStrays);
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
        implSaid = closingParagraphOf(impl.stdout);

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
                return reviewRun(`review-${issue.id}`, prompts.review, { ...promptArgs, IMPL_UNMET: implUnmetView(implUnmet), IMPL_SAID: implSaidView(implSaid), IMPL_CHANGELOG: implChangelogView(changelog) })(agent);
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
                  return crossReview(ref(issue.id), reviewRun(`review-codex-${issue.id}`, prompts.review, { ...promptArgs, IMPL_UNMET: implUnmetView(implUnmet), IMPL_SAID: implSaidView(implSaid), IMPL_CHANGELOG: implChangelogView(changelog) }));
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
      // the merge: that merge is the tree the landing gate ran, so a gate run would return the same red. No full
      // gate run, then: the red gate is re-run once below (the gates before it passed on this tree in the landing's
      // sandbox), and the repair starts from the landing gate's own output when it is red again.
      const redAtLanding = requeued && joined && sh("git", ["rev-parse", branch], project.root) === joined.merge ? repairFromRed(reds.get(issue.id), joined) : undefined;
      reds.delete(issue.id);
      let gated: GateRun;
      if (redAtLanding) {
        const name = redAtLanding.failure.name;
        console.log(
          `${ref(issue.id)}: ${base} has not moved since ${name} went red at landing - ` +
            (ctx.regate && repair > 0 ? `no full gate run; ${name} is re-run first, and a repair starts only if it is red again.` : "no gate run; the repair starts from that output."),
        );
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
      // An attempt's first red, before the base check and the fix board are asked, is run again once from the red gate
      // on: a test that timed out because the machine was busy would otherwise cost a whole repair pass that finds
      // nothing to fix, and the gates after the red one never ran on this tree. Not after a timeout (never repaired),
      // not the forced red (it exists to exercise the repair pass), and never after a repair pass or a fix board merge:
      // this runs before the loop, and only once.
      const first = gated.failure;
      const redAt = first ? gated.gates.findIndex((g) => g.name === first.name) : -1;
      if (ctx.regate && first && first.exitCode !== 124 && !forced && attempts > 0 && redAt >= 0) {
        const again = ctx.regate;
        const rerun = await timed(issue.id, "gates", () => again(sandbox, issue.id, first.name));
        // The passes before the red gate, then the re-run's: still a prefix of the configured gates (`gateResultLines`).
        gated = { ...rerun, gates: [...gated.gates.slice(0, redAt), ...rerun.gates] };
        if (!gated.failure) console.log(`${ref(issue.id)}: ${first.name} red, then green on a re-run - a flake, no repair pass`);
      }
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
        const onBase = await redOnBase(failure, branch, issue.id).catch((error) => {
          if (error instanceof GuardStop) tampered.set(issue.id, error);
          throw error;
        });
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
      const { unmet: unmetNote, implSaid: implSaidNote, changelog: changelogNote, changelogNone: changelogNoneNote, ungated: ungatedNote, gap: gapNote } = agentsSaid();
      // `unmet` written even when undefined, so a green head with every criterion met drops an earlier one.
      if (!gated.failure && !unreviewed) noteHead(issue.id, branch, { green: head, red: undefined, unmet: unmetNote, implSaid: implSaidNote, gates: gated.gates, changelog: changelogNote, changelogDropped: drops.count || undefined, changelogDroppedWhy: drops.why.length ? [...drops.why] : undefined, changelogNone: changelogNoneNote, ungated: ungatedNote, gap: gapNote });
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
        ungated: ungatedNote,
        gap: gapNote,
        changelog: changelogNote,
        changelogDropped: drops.count || undefined,
        changelogDroppedWhy: drops.why.length ? [...drops.why] : undefined,
        changelogNone: changelogNoneNote,
        unmet: unmetNote,
      };
    } finally {
      // Added up: a requeued ticket's second pipeline is more time on it, not a replacement.
      took.set(issue.id, (took.get(issue.id) ?? 0) + Date.now() - started);
      // A pause's close whose check failed removed the container (`removed`): the run stops, and nothing is left here.
      if (!removed && !closedWhileParked) {
        // The sandbox's peak memory, for `sandcastle size`: last read before it closes.
        await recordPeak(sandbox, project.root, runId);
        // The `.git` check is the settle's, before the close; a failure stops the run, and the pipeline keeps its own
        // result, or its own error. Sandcastle keeps a worktree with uncommitted files rather than lose them. Say so,
        // or it lingers unexplained in .sandcastle/worktrees/.
        const closed = await closeSandbox(`after ${ref(issue.id)}`, () => host.settle(branch, `after ${ref(issue.id)}`));
        if (closed?.preservedWorktreePath) keptWorktrees.push({ issue: issue.id, path: closed.preservedWorktreePath });
      } else if (!removed) {
        // A ticket parked by a pause when the run stopped closed its sandbox at the juncture, and keeps its lock like a
        // ticket whose run was killed while paused: the next run's resume releases it. A failed check stops the run.
        await settleAfter(
          () => host.settle(branch, `after ${ref(issue.id)}`),
          (error) => {
            if (!tampered.has(issue.id)) tampered.set(issue.id, error);
          },
        );
      }
    }
  };
};

let unlockOnExit = false;

// The kit this process loaded, read on the first turn: a later turn of an autonomy run runs the same code, so
// a kit pulled mid-run must not be named by it.
let kitAtStart: string | undefined;

/**
 * False when the queue was empty or all of it waiting: nothing ran, so there is no turn to follow.
 * `turn.docker` is the start's one `docker info` reading, which the first turn takes over from the
 * runtime check (cli.ts); a turn handed none reads its own.
 */
export const burndown = async (
  project: Project,
  turn?: { settings: ResolvedSettings; turn: number; docker?: () => string | undefined; acceptGitConfig?: boolean; scope?: { list: string; ids?: Set<string> } },
): Promise<boolean> => {
  const DRY_RUN = process.env.DRY_RUN === "1";
  // This turn's record and summary name a merge-check gap only when this turn's own checks hit it: the note is module state, and a drain runs every turn in one process.
  resetMergeCheckGap();
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
  // The lock, and what a killed run's sandboxes left working stopped, before anything reads or pins the shared `.git`:
  // a container still alive could write it between the baseline check and the reap, past both the refusal and the pins.
  holdAndReap(project);
  // Then, before the pins take the config as it is: a key an earlier, killed run's sandbox planted is refused, not pinned.
  const gitConfig = assertGitConfigBaseline(project, "sandcastle run", turn?.acceptGitConfig);
  pinHostGitConfig(project.root);
  assertCleanBase(project);
  recordGitConfigStart(project, gitConfig);
  // The shared `.git` as the run starts, under its lock and with nothing a killed run left running: the base gates'
  // sandbox, the run's first, opens behind a check against it (the run's own fingerprint is taken once that sandbox
  // has closed). Sandcastle's open runs host git in the project, and the image build and preflight come between.
  const atStart = gitFingerprint(project);
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
  // A run whose operator named tickets (`turn.scope`, the first turn's list, kept across every turn) covers only
  // those: a queued ticket they left out is not listed, recorded or reported, and a later turn's list is no wider.
  const scope = turn?.scope ? (turn.scope.ids ??= scopeIds(tracker, turn.scope.list, queued)) : undefined;
  const whole = named.list ? wholeQueue(tracker, queued, scope) : queued;
  const wholeOpen = await openOnQueue(project, tracker, whole);
  const held = new Map<string, { ticket: Issue; on: Blocker[] }>(queued.flatMap((i) => (wholeOpen.has(i.id) ? [[i.id, { ticket: i, on: wholeOpen.get(i.id)! }] as const] : [])));
  const waiting = [...wholeOpen].map(([id, on]) => ({ issue: id, on: on.map(refLabel) }));
  // A comment is not read as a blocker; say so where the run would start the issue.
  for (const f of await commentOnlyBlocks(project, tracker, queued.map((t) => ({ ...t, queued: true })))) console.log(`  warning: ${commentBlockLine(f)}`);
  // A blocker that can never close (missing, a cycle) holds its ticket for good; an unnamed Linear key lets it start.
  // The whole queue's ids, so a blocker queued outside the named tickets is not called "not queued".
  for (const line of await blockerProblems(project, tracker, queued, new Set(whole.map((t) => t.id)))) console.log(`  warning: ${line}`);
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
  // Filled by the ticket list below, which already says a file hold; `holds.start` then does not say it again.
  const listed = new Set<string>();
  const holds = createHoldRecord({
    waiting,
    ref,
    listed,
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
  kitAtStart ??= kitVersion();

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
    if (later) listed.add(i.id);
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
  console.log(versionsLine(versions, kitAtStart));
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
    return { project: name, root: found?.root, pid: m.pid, registered: m.registered, held: m.held, demand: m.demand, wait: found && name ? firstSlotWait({ root: found.root, name } as Project, found.record) : undefined };
  }), !DRY_RUN, project.name, project.root)) console.log(line);
  // Carried branches, read before any agent touches them: dearer than fresh tickets, so the estimate and the timings say so.
  const carriedAtStart = new Set(candidates.filter((i) => isCarried(project.root, project.baseBranch, i.id)).map((i) => i.id));
  // A remainder: re-run for what an earlier "part of" merge left, so its work is mostly on the base already and it costs less than a fresh ticket.
  const remainderAtStart = new Set(candidates.filter((i) => isRemainder(project.root, project.baseBranch, i.id)).map((i) => i.id));
  // Sandboxes at once: the estimate's divisor, and the status view's guess at when landing starts. A dry run keeps no slot for landing.
  const slots = estimateSlots(workers, split, !DRY_RUN);
  // The path count of each ticket's `Touches:` line (0 with none): the estimate prices a ticket by its size, and each timings line records it for later runs.
  const touchPaths = new Map(candidates.map((i) => [i.id, parseTouches(i.body ?? "").length]));
  const chainIds = blockerChain(project, tracker, candidates);
  const rough = estimate(
    project, candidates.length, slots, chainIds.length,
    candidates.map((i) => overrides.get(i.id)?.model ?? IMPL_MODEL),
    { gateSlots: limit("gates"), carried: candidates.map((i) => carriedAtStart.has(i.id)), remainder: candidates.map((i) => remainderAtStart.has(i.id)), touches: candidates.map((i) => touchPaths.get(i.id) ?? 0), chainAt: chainIds.flatMap((id) => { const at = candidates.findIndex((c) => c.id === id); return at < 0 ? [] : [at]; }) },
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
    versions: { kit: kitAtStart, claude: versions.claude, codex: versions.codex },
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
  // The ticket slots the run could use, over the time its tickets work at full demand: the record keeps their mean, not the start's share, which moves.
  const load = createLoadMeter(slots);
  run.finishWith(() => {
    const concurrency = load.mean();
    return { concurrency, load: { concurrency, tickets: candidates.length } };
  });
  // The run record's live values (not settings): what the run wants and its share of the pool now.
  // The share moves as other runs begin and end, so it is read again as well as on a demand change.
  let shown: { demand: number; share: number; cap?: number } = { demand: -1, share: -1 };
  const poolValues = () => {
    // A finished record is the next turn's to replace: a timer writing to it would undo that.
    if (run.finished) return clearInterval(poolWatch);
    const mine = myShare();
    if (!mine) return;
    // As at the start: beside another run a share keeps a slot for landing; alone, the machine limit and the workers bound it.
    // At every look, not only on a change: another run beginning or ending moves that with this run's share unchanged.
    // Counted only while the run asks for all the slots its startable tickets can use: the base gates (one slot) and the tail
    // where the last tickets finish are bound by demand, and would pull the figure down to what the run asked for, not what it ran at.
    load.sample(estimateSlots(workers, otherRuns().length ? { share: mine.share } : undefined, !DRY_RUN), mine.demand >= Math.min(CONCURRENCY, issues.length));
    if (mine.demand === shown.demand && mine.share === shown.share && mine.cap === shown.cap) return;
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
  // Tracked files a gate rewrote, named once for the run however many worktrees it was gated in.
  const gateRewrites = new Set<string>();
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
    let pressure: ReturnType<typeof pressureOf>;
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
      pressure = pressureOf(result);
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
        ...(remainderAtStart.has(issue) ? { remainder: true } : {}),
        ...(touchPaths.has(issue) ? { touches: touchPaths.get(issue) } : {}),
        ...(m ? { model: m } : {}),
        ...(tokens ? { tokens } : {}),
        ...(gateTimes ? { gates: gateTimes } : {}),
        ...(peakMib ? { peakMib } : {}),
        ...pressureFields(pressure),
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
      // The count and the list are the repo's items; Claude Code's own bundled skills are off in every sandbox (container/managed-settings.json).
      "; Claude Code's bundled skills off" +
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
  const hookCheck = await timed("", "hook check", () => checkHooks(project, image, lean, hooksThatRanClean(project, image, planFile)));
  reportHookCheck(hookCheck, lean.hooks.length);
  if (hookCheck.failures.length) throw new OperatorError("A kept hook cannot run in the image - no sandbox started.");
  // The base gates' times when they ran, the verify's fallback record for a gate far slower than it was (`likelyLoad`).
  let baseGateMs: Record<string, number> | undefined;
  if (process.env.SKIP_BASE_GATES === "1") console.log(`SKIP_BASE_GATES=1: the gates on ${base} are not checked first.`);
  else {
    try {
      // Checked against the start's reading before its sandbox opens; closed behind a reading of its own (`gateBase`).
      baseGateMs = gateMs(await timed("", "base gates", () => requireGreenBase(gateProject, image, planFile, true, runId, undefined, (when) => assertGitUnchanged(project, atStart, when))));
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
  // `from`: a red gate's re-run, which starts at that gate (`gatesIn`'s own).
  const runGates = async (sandbox: Parameters<typeof gatesIn>[1], id: string, what?: string, priority = false, from?: string) => {
    markLog(gatesLog(project, id), runId, priority ? "landing gates on the merged tree" : "ticket gates");
    // Said under the header: the section starts past the first gate, which a reader of the log would otherwise take for a lost line.
    if (from !== undefined) appendFileSync(gatesLog(project, id), `# run again from ${from}: the first red gate's re-run, before any repair pass\n`);
    let gateStarted = false;
    const gated = await gatesIn(project, sandbox, gatesLabel(project, ref, id, what), false, {
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
          // A re-run starts past the first gate: its gate time starts at the first one it runs.
          else if (from !== undefined && !gateStarted) step.since = Date.now();
        }
        gateStarted = true;
        run.ticket(id, { note: `${i + 1}/${project.gates.length} ${name}` });
      },
      log: gatesLog(project, id),
    }, priority, from);
    for (const path of gated.rewrote ?? []) {
      if (gateRewrites.has(path)) continue;
      gateRewrites.add(path);
      console.log(rewroteLine(path));
      run.update({ gateRewrites: [...gateRewrites] });
    }
    return gated;
  };

  // The run's waits for a sandbox slot. One held back by the run's share or by the slot kept for landing, not only
  // by a full pool, is the run record's `waitsFor` (and `waitsForShare`, for an older view), which the status
  // view's next-to-start rows say.
  const slotWaits = createSlotWaits((held, waitsFor) => {
    try {
      run.update({ waitsForShare: held || undefined, waitsFor });
    } catch {
      /* the record's note only: a throw here would end the wait it describes */
    }
  });
  // A run is silent for as long as its agents are, which for a review can be
  // half an hour. One line every five minutes says it is alive and where, and says when the run
  // has waited for a sandbox slot longer than a typical issue takes: a stall nobody sees otherwise.
  // Sandcastle prints a `tail -f` line for every pass; a ticket keeps its first. Put back where the heartbeat stops.
  const consoleLog = console.log;
  const tailFilter = createTailFilter();
  console.log = (...args: unknown[]) => {
    if (tailFilter(format(...args))) consoleLog(...args);
  };
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
  // And what earlier runs filed from the tickets this turn runs, from the history: a repeat of one is a comment on its issue.
  const followUps = createFollowUpBook(run, {
    tracker,
    dryRun: DRY_RUN,
    write: (fn) => host.write(fn, trackerMade(project.root)),
    seen: filedThisRun,
    places: placesThisRun,
    exists: onBase(project.root, project.baseBranch),
    named: namedOnBase(project.root, project.baseBranch),
    earlier: filedBefore(project.root, new Set(candidates.map((c) => c.id)), (id) => tracker.isClosed(id)),
  });

  // Each ticket's red landing gate, for its requeue (`ctx.reds`).
  const reds = new Map<string, RedLanding>();

  const gateNames = project.gates.map((g) => g.name).join(", ");

  const slotWanted = { n: 0 };
  const landed = new Map<string, { files: string[]; commit: string; clean?: true }>();
  // Each landing's gate times, the record a red verify of the tree it gated is judged by (`likelyLoad`).
  const landingGateMs = new Map<string, Record<string, number>>();
  const ctx: LandContext = {
    project,
    tracker,
    base,
    gateNames,
    reports,
    run,
    dryRun: DRY_RUN,
    opener: sandboxOpener(gateProject, image, planFile, host.exclusive),
    greenBase: (commit, by, kind) => noteGreenCommit(gateProject, image, planFile, commit, by, kind),
    runId,
    withdrawal,
    host,
    // Named apart: a green ticket's wait read as if its branch gates had started again.
    gate: async (box, id) => {
      const result = await timedLandingGate(timings, { run: runId, project: project.name, issue: id, carried: carriedAtStart.has(id) }, () => runGates(box, id, "landing gate", true));
      const times = gateMs(result);
      if (times) landingGateMs.set(id, times);
      return result;
    },
    landed,
    slotWanted,
    // The heartbeat says the wait as a wait; the landing's time counts from the slot, as a gates step's from its first gate.
    slotWait: (issue, state) => {
      const step = landing.get(issue);
      if (!step) return;
      if (state === "waiting") step.phase = "waiting for a sandbox slot";
      else {
        delete step.phase;
        step.since = Date.now();
      }
    },
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
    open: (branch) => openOrAbandon(project, branch, () => createSandbox({ branch, baseBranch: base, ...sandboxConfig(project, image, planFile) }), host.exclusive),
    gate: (box, id) => runGates(box, id),
    regate: (box, id, from) => runGates(box, id, undefined, false, from),
    baseGate: (id) =>
      timedGate(BASE_RED, timings, { run: runId, project: project.name, issue: id, carried: carriedAtStart.has(id) }, () =>
        gateBase(gateProject, image, planFile, "base-red", false, runId, false, true, (when) => host.check(when), undefined, host.exclusive),
      ).then((r) => {
        // The wait for the gates slot is inside the ticket's time but not its usual time, as a gates step's is.
        if (r.waitMs) waited.set(id, (waited.get(id) ?? 0) + r.waitMs);
        return r;
      }),
    baseRecordedGreen: () => baseRecordedGreen(gateProject, image, planFile),
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
    tickets: candidates,
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
          ...(value.changelogNone ? { changelogNone: true } : {}),
          ...(value.changelogDroppedWhy?.length ? { changelogDroppedWhy: value.changelogDroppedWhy } : {}),
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
    let limited: { resets?: string } | undefined;
    bookkeep(issue.id, () => {
      // Kept open even at the end of the queue: a crash is for a human to read.
      view.finish(issue.id, "crashed");
      limited = planLimit(project.root, issue.id);
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
    land: async (o, behind) => {
      landing.set(o.issue, { since: Date.now() });
      try {
        return await landingPorts.land(o, behind);
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
      case "setup problem":
        // Said as it holds: the tickets in flight go on printing, and each would read as a run that still starts more.
        run.update({ setupProblem: c.line });
        console.log(`\nSTOPPED starting tickets: ${causeWords({ kind: "setup problem", line: c.line }, ref)}. Tickets already running finish.`);
        return view.refresh();
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
        run.update({ stopped: String((error as Error).message ?? error), stoppedWhat: guardWords(error).what });
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
    const filed = await followUps.file(unsafe);
    // One line for the set, and the record says it once for the summary: the reason is the same for each.
    const withheld = unsafe !== undefined ? filed.filter((f) => !f.id && f.failed === unsafe) : [];
    if (withheld.length) {
      run.update({ followUpsWithheld: unsafe });
      console.log(`${withheld.length === 1 ? "1 follow-up was" : `${withheld.length} follow-ups were`} not filed: ${unsafe}. ${withheld.length === 1 ? "It is" : "They are"} listed in the summary to file by hand.`);
    }
    for (const f of filed) {
      if (withheld.includes(f)) continue;
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
    // A merge check that could not run before the stop is named in this summary too: the run's end never comes.
    const mergeUnchecked = mergeCheckGap();
    run.update({ stopped: why, paused: undefined, ...(mergeUnchecked && { mergeUnchecked }) });
    // The cause in a few words, for the summary's next step: only a guard stop has one.
    if (safety) run.update({ stoppedWhat: guardWords(error).what });
    try {
      await fileTheFollowUps(safety ? `${guardWords(error).what}, so nothing more was written to the tracker` : undefined);
    } catch (e) {
      // Whatever went wrong here must not replace the reason the run stopped.
      console.log(`Could not file the agents' follow-ups: ${errorLine(e)}`);
    }
    console.log(`\n${await closingReport(project)}\n`);
    // The summary holds the stop's message: the CLI printing it again on exit made it twice.
    throw reportedError(error);
  };

  const { endings, stop } = await schedule
    .run({ workers, concurrency: CONCURRENCY, slot: (wanted) => sandboxSlot("next ticket", () => !wanted()), landingWaits: () => slotWanted.n > 0, attempt, ...landings, tell, pause: { read: () => (usagePause ? usagePause.source.read() : readPause(project.root, process.pid)) } })
    .catch((error: unknown) => {
      clearInterval(heartbeat);
      console.log = consoleLog;
      usageWatch?.stop();
      // A write the host git refused is a safety stop as it happens; a `.git` change the scheduler's own state
      // would have named is lost with its rejection, and the writer's check refuses such a write by itself.
      return stopLanding(error, host.failed !== undefined);
    });
  clearInterval(heartbeat);
  console.log = consoleLog;
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
  let verifySkipped: { commit: string; by?: string; kind: ProofKind } | undefined;
  let newDockerfiles: string[] = [];
  let verifyFailingTests: ReturnType<typeof verifyFailing> | undefined;
  let verifyTreeOf: string | undefined;
  let verifyCleanTreeOf: string | undefined;
  let verifyLoad = false;
  let verifyNotRun: string | undefined;
  const verifyDue = verifyPlan(gateProject, image, planFile, merged.length, regenerated);
  if (verifyDue.due) {
    // Verify is proof that the merged base is green in a clean gate-only sandbox: a landing merged in a sandbox, the base
    // check or an earlier verify may have gated exactly this tip, and the green-base record says so. A fast-forward's
    // ticket gates ran in the agent's own sandbox, so they are no proof, one ticket's included (it names no tip after a
    // failed note: then it runs).
    verifySkipped = verifyDue.skipped;
    let gated: { gates: Gate[]; failures: GateRun["failures"] } = { gates: [], failures: [] };
    // The skip is said once, in the closing summary.
    if (!verifySkipped) {
      // The scheduler told its last demand, 0: the verify's own sandbox is one slot.
      setDemand(1);
      // Red once is run again, the second result kept: a load flake beside other runs' suites is not a red base.
      try {
        gated = await timed("", "verify", () => rerunRedVerify(() => verifyBase(gateProject, image, planFile, runId, (when) => host.check(when), host.exclusive), (line) => console.log(line))).finally(() => setDemand(0));
      } catch (error) {
        // A guard's refusal still stops the run. A sandbox that would not open (Sandcastle's worktree timeout behind a
        // hung fetch, a slow container start) left the merged base ungated: the summary must still print and say so,
        // where the error used to escape and end the run with a stack trace and no summary.
        if (error instanceof OperatorError && !(error instanceof SlowStartError)) throw error;
        verifyNotRun = errorLine(error);
        console.log(`verify could not run: ${verifyNotRun}`);
      }
    }
    verify = gated.gates;
    const verifyRed = verifyFailing(gated.failures);
    verifyFailingTests = verifyRed;
    newDockerfiles = changedDockerfiles(project, startTip, base);
    // A red verify on a tree a landing's own gates passed is red for its sandbox, not for the tickets meeting.
    if (verify.some((g) => !g.pass)) {
      const same = landingOfTree(project.root, `refs/heads/${base}`, landed, project.tracker.kind === "files" ? project.tracker.dir : undefined);
      // A tree a landing sandbox gated was green in a clean sandbox already: no sandbox difference, a flaky test.
      if (same && landed.get(same)?.clean) verifyCleanTreeOf = ref(same);
      else if (same) verifyTreeOf = ref(same);
      // Timeouts alone, or a gate far slower than it was: the run was loaded, whatever tree it gated. Judged against the
      // gates of the landing that gated this tree, else the run's base gates.
      verifyLoad = likelyLoad(gated.failures, gated.gates, { ...baseGateMs, ...(same && landed.get(same)?.clean ? landingGateMs.get(same) : undefined) });
    }
    // A red merged base said "do not push" with nothing to read: its full output is in the verify log (`verifyBase`
    // streamed it as the gates ran). A skipped verify ran nothing: a log an earlier run left would read as this one's.
    if (verifySkipped) rmSync(join(project.root, VERIFY_LOG), { force: true });
    if (gated.failures.length) {
      // The last lines are often an assertion dump and the package manager's exit: the failing tests' names come first.
      if (verifyRed.tests.length) console.log(`\n--- verify failing tests: ${verifyRed.tests.join(", ")}${verifyRed.more ? ", and more" : ""}`);
      for (const f of gated.failures) console.log(`\n--- verify ${f.name} (exit ${f.exitCode}), last lines:\n${f.output.split("\n").slice(-15).join("\n")}`);
      console.log(`Full output: ${VERIFY_LOG}`);
    }
  }
  const mergeUnchecked = mergeCheckGap();
  run.update({ stage: "report", ...(mergeUnchecked && { mergeUnchecked }) });

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
    verify: verifyNotRun ? { green: false, line: "not run", image, notRun: verifyNotRun } : verify ? { green: verify.every((g) => g.pass), line: gateLine(verify), image, ...(verifyFailingTests?.tests.length ? { failing: verifyFailingTests.tests, ...(verifyFailingTests.more ? { failingMore: true } : {}) } : {}), ...(verifySkipped ? { skipped: verifySkipped } : {}), ...(verifyTreeOf ? { gatedTree: verifyTreeOf } : {}), ...(verifyCleanTreeOf ? { cleanTree: verifyCleanTreeOf } : {}), ...(verifyLoad ? { likelyLoad: true } : {}), ...(newDockerfiles.length ? { dockerfiles: newDockerfiles } : {}) } : null,
    keptWorktrees,
    ...(gateRewrites.size ? { gateRewrites: [...gateRewrites] } : {}),
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
