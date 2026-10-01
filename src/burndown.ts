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
//   Phase 3  Land    - green branches merge to the base branch; the issue is
//                      closed with a comment. Red branches, and green ones
//                      that change hooks/CI/install scripts, are left standing.
//   Phase 4  Verify  - the gates once more on the merged base branch, because
//                      two branches green on their own can be red together.
//
// Environment: ISSUES=1,2 (instead of the queue label), CONCURRENCY, DRY_RUN=1 (`sandcastle run 1 2
// --dry --concurrency N` set the same three),
// SANDCASTLE_TEST_RED_GATE=1, SKIP_BASE_GATES=1, plus the model variables in agents.ts and the
// machine-wide limits in pool.ts.

import { createSandbox } from "@ai-hero/sandcastle";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CROSS_REVIEW, CROSS_REVIEW_MODEL, IMPL_MODEL, MODELS_LINE, crossReview, implAgent, reviewWithFallback } from "./agents.ts";
import type { Project } from "./config.ts";
import { type Gate, failingTests, failureKey, gateBase, gateLine, gateMs, gateRed, requireGreenBase, runGates as gatesIn } from "./gates.ts";
import { blockerResolver, commentBlockLine, commentOnlyBlocks, openBlockers, refLabel } from "./blockers.ts";
import { assertGitUnchanged, disableHostGitHooks, gitFingerprint, lockRun, protectedChanges } from "./guard.ts";
import { checkHooks, hiddenReferences, reportHookCheck, writePlan } from "./lean.ts";
import { IN_HERDR, openSandboxView } from "./herdr.ts";
import { limit, usage, wholeNumber, withSlot } from "./pool.ts";
import {
  addTokens, agentLog, archiveFinishedLogs, assertCleanBase, dirtyFiles, gatesLog, keepAwake, landOnlyHead, markLog, NO_TOKENS, openStatusPane, preflight, recordHead, recordOutcomes,
  recordRun, renderPrompts, runTokens, type TicketRecord, type Tokens, tokenBrief, estimate, tokenLine, typicalTimes, usedArgs, logOwner,
} from "./run.ts";
import { AGENT_COMMITTER, credentials, ensureImage, errorLine, ownCommits, reapOrphans, sandboxConfig, sh } from "./sandbox.ts";
import { LATEST_ISSUE, ensureTriageLabel, makeTracker, refOf, type Ticket } from "./tracker.ts";
import { closingReport } from "./report.ts";
import { usageLine, usageStop } from "./usage.ts";
import { lockWorktree, releaseBranchWorktree, unlockAll, unlockWorktree } from "./worktree-lock.ts";
import { OperatorError } from "./errors.ts";
import { hostIdentity, regensFor, resolveGenerated, shq } from "./generated.ts";
import { landInSandbox, sandboxOpener } from "./land.ts";

type Issue = Ticket;
type Outcome = {
  issue: string;
  branch: string;
  // "green", never "shipped": the pane titles said shipped while nothing had
  // landed, and the status table said queued - a run read as going in circles.
  status: "green" | "gate-failed" | "nochange" | "merged-earlier";
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
};

// A branch's outcome as the status view's row shows it, before landing.
const outcomeText = (o: Outcome) =>
  o.status === "gate-failed" ? `gate red: ${gateLine(o.gates.filter((g) => !g.pass))}` : o.status === "green" ? "green - lands when the run ends" : o.status;

// What an issue's pane and sidebar entry say when its pipeline ends - the
// status table's words, so the two never disagree.
const finishWord = (o: Outcome) =>
  ({ green: "ready to land", "gate-failed": "gate red", nochange: "no change", "merged-earlier": "ready to land" })[o.status];

// "with #12" names the branches merged before it that changed the same files.
const conflictLine = (c: { files: string[]; with: string[] }) =>
  (c.with.length ? `with ${c.with.map(refOf).join(", ")}: ` : "") +
  `${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? ` and ${c.files.length - 3} more` : ""}`;

// The one comment a ticket that did not land gets: the conflict (the other
// ticket and the files), the agents' report, or both - never two comments.
export const notLandedComment = (
  report: string | undefined,
  conflict: { branch: string; base: string; files: string[]; with: string[] } | undefined,
): string | undefined => {
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

// The ticket closes on the local merge, so the comment says the work is not on
// the remote yet: a repo that deploys on push has nothing live when this reads "done".
export const closeComment = (
  o: { branch: string; commits: number; repairs: number; regenerated?: { files: string[]; regen: string[] } },
  gateNames: string,
  report?: string,
): string =>
  `Merged locally, not yet pushed, by the Sandcastle loop from \`${o.branch}\` (${o.commits} commit(s)` +
  (o.repairs ? `, ${o.repairs} repair pass(es) after a red gate` : "") +
  `); ${gateNames} all green before merge.` +
  (o.regenerated
    ? ` Conflicts in generated files (${o.regenerated.files.join(", ")}) were resolved by running ${o.regenerated.regen.map((c) => `\`${c}\``).join(", ")}.`
    : "") +
  (report ? `\n\n${report}` : "");

// The landing merge. The subject must stay `Merge <branch> (closes <ticket>)`:
// `mergedEarlier` and status.sh's `requeued` find a landed branch by it. The committer is
// the agent's, the author the operator's (see AGENT_COMMITTER).
// --no-verify: a pre-commit hook re-running what the gates covered only adds a way for a
// green branch to fail to land. (Hooks are off for the whole host process anyway - see guard.ts.)
export const mergeBranch = (root: string, branch: string, head: string, ticket: string) =>
  sh("git", ["merge", "--no-ff", "--no-verify", "-m", `Merge ${branch} (closes ${ticket})`, head], root, AGENT_COMMITTER);

/** Tickets to hold for the next run: each shares a file with an earlier ticket in `ids` that does start. */
export const fileOverlaps = (root: string, base: string, ids: string[]): { id: string; with: string; files: string[] }[] => {
  // Three dots: the branch's own changes since it forked or last merged the
  // base, so work that landed on the base meanwhile is not counted against it.
  // No branch (a new ticket) or an empty diff means no files, never held.
  const filesOf = (id: string): string[] => {
    try {
      sh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/agent/issue-${id}`], root);
      return sh("git", ["diff", "--name-only", `${base}...agent/issue-${id}`], root).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const kept: { id: string; files: Set<string> }[] = [];
  const held: { id: string; with: string; files: string[] }[] = [];
  for (const id of ids) {
    const files = new Set(filesOf(id));
    const first = kept.find((k) => [...files].some((f) => k.files.has(f)));
    if (first) held.push({ id, with: first.id, files: [...files].filter((f) => first.files.has(f)).sort() });
    else kept.push({ id, files });
  }
  return held;
};

export const burndown = async (project: Project) => {
  const DRY_RUN = process.env.DRY_RUN === "1";
  // A test of the repair path itself. An agent that can read a gate makes it
  // pass before it exits, so a live run almost never reaches a repair; this
  // counts each issue's first gate run as red, with an output that says so.
  // Off without repair passes: a forced red nobody repairs would only hold
  // good work back.
  const TEST_RED_GATE = process.env.SANDCASTLE_TEST_RED_GATE === "1" && (project.repair.attempts ?? 1) > 0;
  // Four by default, not one-per-issue. Twelve at once saturated a 15-core
  // machine to load 33 and starved a vitest run into a false gate failure -
  // good work withheld by resource contention rather than by a defect.
  const CONCURRENCY = wholeNumber("CONCURRENCY", process.env.CONCURRENCY ?? project.concurrency, 1);
  const base = project.baseBranch;

  // Fail before spending a single container.
  disableHostGitHooks();
  assertCleanBase(project);
  lockRun(project);
  reapOrphans(project);

  // The work list lives in the tracker (GitHub labels, or ticket files), never
  // in an agent's context. Named tickets are checked on the host, so a typo or
  // a closed ticket fails here and not inside a sandbox that has already
  // installed its dependencies.
  const tracker = makeTracker(project);
  const ref = tracker.ref;
  const queued: Issue[] = process.env.ISSUES
    ? process.env.ISSUES.split(",").map((n) => {
        const t = tracker.get(n.trim());
        if (!t.open) throw new Error(`${ref(t.id)} is closed.`);
        return t;
      })
    : tracker.queued();
  if (queued.length === 0) {
    console.log(`No ${project.label} tickets. Queue drained.`);
    return;
  }

  // An issue whose blocker is still open waits - including a blocker in this
  // same run, which cannot be on base before landing, so the dependent would
  // branch without it. The next run picks it up. Blockers are GitHub issues
  // and, if the project configures them, Linear issues and task files
  // (blockers.ts); one that cannot be read counts as open.
  const resolve = blockerResolver(project, tracker, new Set(queued.map((i) => i.id)));
  const waiting = (
    await Promise.all(
      queued.map(async (i) => {
        const on = await openBlockers(project, tracker, resolve, i);
        return on.length ? [{ issue: i.id, on: on.map(refLabel) }] : [];
      }),
    )
  ).flat();
  for (const w of waiting) console.log(`  ${ref(w.issue)} waits for ${w.on.join(", ")} to close`);
  // A comment is not read as a blocker; say so where the run would start the issue.
  for (const f of await commentOnlyBlocks(project, tracker, queued.map((t) => ({ ...t, queued: true })))) console.log(`  warning: ${commentBlockLine(f)}`);
  // A ticket others wait for starts first; otherwise the tracker's order
  // holds. The two blockers of seven waiting tickets once ran last of thirty,
  // so a run stopped early would have left all seven stuck for another run.
  // (Their dependants still wait for the next run: landing is at the end.)
  const unblocks = (i: Issue) => waiting.filter((w) => w.on.includes(ref(i.id))).length;
  const ready = queued.filter((i) => !waiting.some((w) => w.issue === i.id)).sort((a, b) => unblocks(b) - unblocks(a));
  // Landing is once, after every pipeline, so two tickets whose existing
  // branches change one file would both fork from the old base and the second
  // would conflict. One per group starts; the rest wait for the next run.
  const overlaps = fileOverlaps(project.root, base, ready.map((i) => i.id));
  for (const o of overlaps) {
    waiting.push({ issue: o.id, on: [ref(o.with)] });
    console.log(`  ${ref(o.id)} waits for ${ref(o.with)}: both branches change ${o.files.slice(0, 3).join(", ")}${o.files.length > 3 ? ` and ${o.files.length - 3} more` : ""} - next run`);
  }
  const issues = ready.filter((i) => !overlaps.some((o) => o.id === i.id));
  if (issues.length === 0) {
    console.log("Every queued issue is waiting on another. Nothing to start.");
    return;
  }

  console.log(`${issues.length} issue(s), ${CONCURRENCY} at a time${DRY_RUN ? " [DRY RUN]" : ""} - ${MODELS_LINE}:`);
  for (const i of issues) console.log(`  ${ref(i.id)} ${i.title}`);
  // Sandboxes at once: the estimate's divisor, and the status view's guess at when landing starts.
  const slots = Math.min(CONCURRENCY, issues.length, limit("sandboxes"));
  const rough = estimate(project, issues.length, slots);
  if (rough) console.log(rough);
  console.log(`Machine-wide: ${usage()}`);
  console.log(`Keep awake: ${keepAwake()}`);
  if (TEST_RED_GATE) {
    console.log(
      "SANDCASTLE_TEST_RED_GATE=1: each issue's first gate run counts as red, to test the repair pass. " +
        "Each issue pays for a repair agent and another full gate run - a test switch, not for real runs.",
    );
  } else if (process.env.SANDCASTLE_TEST_RED_GATE === "1") console.log("SANDCASTLE_TEST_RED_GATE=1 ignored: repair.attempts is 0.");

  // The run is on record and on screen before anything slow starts: a cold
  // image check, preflight and base gates took over three minutes with no
  // view at all, and the chosen issues looked like the rest of the queue.
  // `tickets` is where the status view reads each ticket's state from; a
  // held-back one says whether this run can reach it.
  const inRun = new Set(issues.map((i) => ref(i.id)));
  // Notes are short: the view's activity column is about 30 characters in an 80-column pane.
  const blockedNote = (on: string[]) => {
    const here = on.filter((b) => inRun.has(b));
    return `waits for ${on.join(", ")}` + (here.length === on.length ? " (this run) - next run" : here.length ? ` (${here.join(", ")} this run)` : "");
  };
  const run = recordRun(project, {
    issues: issues.map((i) => i.id),
    dryRun: DRY_RUN,
    waiting,
    stage: "starting",
    concurrency: slots,
    typical: typicalTimes(project),
    tickets: Object.fromEntries([
      ...issues.map((i, order) => [i.id, { state: "queued", order, since: Math.floor(Date.now() / 1000), title: i.title }]),
      ...waiting.map((w) => [w.issue, { state: "blocked", note: blockedNote(w.on), title: queued.find((q) => q.id === w.issue)?.title }]),
    ]),
  });
  // Released on any exit, Ctrl-C included, so the clean-up command Sandcastle
  // prints for a kept worktree works as printed.
  process.on("exit", unlockAll);
  // Inside Herdr, the run's own tab: the status view and one pane per
  // concurrent sandbox, reporting each one's phase. Otherwise (or with the
  // view off) the status view opens beside the caller. Inside Herdr a run
  // with no status view does not start: nobody would see it.
  const view = openSandboxView(project, Math.min(CONCURRENCY, issues.length), ref);
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
  const timed = async <T>(issue: string, phase: string, fn: () => Promise<T> | T, note?: string, model?: () => string | undefined): Promise<T> => {
    const since = Date.now();
    active.set(issue, { phase, since });
    if (issue) {
      view.phase(issue, phase);
      run.ticket(issue, { state: phase, ...(phase === "setup" ? { started: Math.floor(since / 1000) } : {}), ...(note ? { note } : {}) });
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

  const image = await timed("", "image", () => ensureImage(project));
  const prompts = renderPrompts(project, tracker, DRY_RUN);
  await timed("", "preflight", () => preflight(project, image));
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
  else await timed("", "base gates", () => requireGreenBase(project, image, planFile));
  // What the tracker says about each ticket now, to prove a dry run left it alone.
  const before = DRY_RUN ? tracker.snapshot(issues.map((i) => i.id)) : undefined;
  // Agents label the follow-up issues they file; the sandbox token cannot create the label.
  if (tracker.kind === "github" && !DRY_RUN) ensureTriageLabel();
  run.update({ stage: "running" });
  const fingerprint = gitFingerprint(project);
  // Set when the shared .git changed under us; no further issue starts.
  let tampered: string | undefined;
  // Every failed .git check's message: each in-flight pipeline fails its own
  // once the base moves, and one string was overwritten between a throw and
  // its handler, so a stopped ticket read as crashed.
  const stops = new Set<string>();

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
  // called off, and again before landing, so none of it merges. An `ISSUES=`
  // ticket that never carried the label started with no status, so its status
  // is not checked.
  const withdrawal = (id: string): { held: boolean; reason: string } | undefined => {
    const now = tracker.get(id);
    const startedAs = issues.find((i) => i.id === id)?.status;
    if (now.held) return { held: true, reason: "marked needs-human during the run" };
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
  // landing (concurrent commits to the base branch would race on its index).
  const reports = new Map<string, string>();
  const notes: { issue: string; kind: "comment" | "hold"; text: string }[] = [];
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
    const promptArgs = { ISSUE_NUMBER: issue.id, TICKET: ref(issue.id), ...tracker.promptArgs(issue.id) };
    const merge = mergedEarlier(issue.id, branch);
    if (merge) {
      return { issue: issue.id, branch, status: "merged-earlier", commits: 0, reviewCommits: 0, repairs: 0, gates: [], head: merge };
    }
    view.claim(issue.id, issue.title);

    const started = Date.now();
    releaseBranchWorktree(branch);
    const sandbox = await timed(issue.id, "setup", () =>
      createSandbox({ branch, baseBranch: base, ...sandboxConfig(project, image, planFile) }),
    );

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
      const behind = Number(sh("git", ["rev-list", "--count", `${branch}..${base}`]));
      // Read before the base merge, which moves the tip. A branch still at the
      // head it was reviewed and gated green on needs no implement or review:
      // only the merge and the gates stand between it and landing.
      const greenHead = carried ? landOnlyHead(project.root, base, issue.id) : undefined;
      let landOnly = greenHead !== undefined;
      if (greenHead !== undefined) {
        console.log(`${ref(issue.id)}: reviewed and green at ${greenHead.slice(0, 7)} in an earlier run - no implement or review; the gates decide.`);
        run.ticket(issue.id, { note: "land only - reviewed earlier" });
      }
      let mergeConflicted = false;
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
            console.log(`${ref(issue.id)}: merged ${base} (${behind} commit(s)) into its branch from an earlier run; regenerated ${files.join(", ")} with ${r.regen.map((c) => `\`${c}\``).join(", ")}.`);
          } else {
            // Back to the merge as it stood, for the implementer (or, on a green
            // branch, the resolver) to resolve.
            await sandbox.exec("git merge --abort");
            await sandbox.exec(merge);
            mergeConflicted = true;
            console.log(
              `${ref(issue.id)}: its ${landOnly ? "green branch" : "branch from an earlier run"} conflicts with ${base} in generated files (${files.join(", ")}), and regenerating failed (${r.reason}); ${landOnly ? "a resolver resolves the merge, then the gates run" : "the implementer resolves the merge"}.`,
            );
          }
        } else if (pull.exitCode === 0) console.log(`${ref(issue.id)}: merged ${base} (${behind} commit(s)) into its branch from an earlier run.`);
        else if (unmerged) {
          mergeConflicted = true;
          console.log(
            landOnly
              ? `${ref(issue.id)}: its green branch conflicts with ${base} (${files.join(", ")}); a resolver resolves the merge, then the gates run.`
              : `${ref(issue.id)}: its branch from an earlier run conflicts with ${base} (${unmerged.split("\n").join(", ")}); the implementer resolves the merge.`,
          );
        }
        else {
          // Refused outright (untracked files it would overwrite, say): no
          // merge in progress, so nothing for the prompt to name.
          await sandbox.exec("git merge --abort");
          console.log(`${ref(issue.id)}: could not merge ${base} into its branch (${(pull.stderr || pull.stdout).trim().split("\n").at(-1)?.slice(0, 160)}); it may conflict at landing.`);
        }
      }
      // A conflicted merge on a branch that is already reviewed and green needs
      // only the merge resolved, not the issue implemented again: a short prompt
      // on the same sandbox. A resolver that leaves the merge in progress could
      // not resolve it without changing what the ticket does, so the full
      // implementer takes the branch, as it does for any carried branch.
      if (landOnly && mergeConflicted) {
        await timed(issue.id, "implement", () => {
          markLog(agentLog(project, issue.id, `impl-${issue.id}`), runId);
          return sandbox.run({
            name: `impl-${issue.id}`,
            agent: implAgent(),
            promptFile: prompts.resolve,
            promptArgs: usedArgs(prompts.resolve, promptArgs),
            maxIterations: project.repair.maxIterations ?? 4,
            idleTimeoutSeconds: project.repair.idleTimeoutSeconds ?? 2400,
          });
        },
          "resolving the base merge",
          () => IMPL_MODEL,
        ).catch((error) => {
          if (hitLimit(issue.id)) throw error;
          console.log(`${ref(issue.id)}: the resolver failed (${String(error).slice(0, 120)}).`);
        });
        if ((await sandbox.exec("git rev-parse -q --verify MERGE_HEAD")).exitCode === 0) {
          console.log(`${ref(issue.id)}: the merge is still unresolved - the full implement and review run.`);
          landOnly = false;
        }
      }
      // Review passes run on the same warm sandbox and branch. Their commits
      // ride the same gates as the implementer's, so a review that breaks the
      // build cannot merge either. Log names keep `-review-` for status.sh.
      const reviewRun = (name: string, promptFile = prompts.review, args: Record<string, string> = promptArgs) => (agent: Parameters<typeof sandbox.run>[0]["agent"]) =>
        sandbox.run({
          name,
          agent,
          promptFile,
          promptArgs: usedArgs(promptFile, args),
          maxIterations: project.review.maxIterations ?? 3,
          idleTimeoutSeconds: project.review.idleTimeoutSeconds ?? 2400,
        });
      let reviewCommits = 0;
      if (!landOnly) {
        const impl = await timed(issue.id, "implement", () => {
          markLog(agentLog(project, issue.id, `impl-${issue.id}`), runId);
          return sandbox.run({
            name: `impl-${issue.id}`,
            agent: implAgent(),
            promptFile: prompts.implement,
            promptArgs: usedArgs(prompts.implement, promptArgs),
            maxIterations: project.implement.maxIterations ?? 8,
            idleTimeoutSeconds: project.implement.idleTimeoutSeconds ?? 2400,
          });
        },
          undefined,
          () => IMPL_MODEL,
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

        let reviewModel: string | undefined;
        const review = await timed(
          issue.id,
          "review",
          () => {
            markLog(agentLog(project, issue.id, `review-${issue.id}`), runId);
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
                markLog(agentLog(project, issue.id, `review-codex-${issue.id}`), runId);
                return crossReview(ref(issue.id), reviewRun(`review-codex-${issue.id}`));
              },
              undefined,
              () => CROSS_REVIEW_MODEL,
            )
          : undefined;
        noteHead(issue.id, branch, { reviewed: sh("git", ["rev-parse", branch]) });
        reviewCommits = review.commits.length + (cross?.commits.length ?? 0);
        if (!tracker.agentsWrite) {
          for (const [who, r] of [["Reviewer", review], ["Cross-reviewer", cross]] as const) {
            const said = r && tags(r.stdout).report;
            if (said) addReport(issue.id, who, said);
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
          markLog(agentLog(project, issue.id, `repair-${issue.id}`), runId);
          return sandbox.run({
            name: `repair-${issue.id}`,
            agent: implAgent(),
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
          () => IMPL_MODEL,
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
            markLog(agentLog(project, issue.id, `review-${issue.id}`), runId);
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
      };
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      took.set(issue.id, Date.now() - started);
      unlockWorktree(sandbox.worktreePath);
      // Sandcastle keeps a worktree with uncommitted files rather than lose
      // them. Say so, or it lingers unexplained in .sandcastle/worktrees/.
      const closed = await sandbox.close();
      if (closed.preservedWorktreePath) keptWorktrees.push({ issue: issue.id, path: closed.preservedWorktreePath });
      try {
        assertGitUnchanged(project, fingerprint, `after ${ref(issue.id)}`);
      } catch (error) {
        stops.add(String(error));
        tampered ??= String(error);
        // A pipeline that crashed on its own keeps its own error; the run
        // stops either way.
        if (failed === undefined) throw error;
      }
    }
  };

  // A spent plan allowance fails every issue after it the same way, each one
  // after paying for a sandbox and an install. The first one stops the queue.
  let limitHit: string | undefined;
  let usageHit: string | undefined;
  const hitLimit = (issue: string) => {
    const logs = join(project.root, ".sandcastle/logs");
    if (!existsSync(logs)) return false;
    return readdirSync(logs)
      .filter((f) => logOwner(f) === issue)
      .some((f) => LIMIT.test(readFileSync(join(logs, f), "utf8").split("\n").slice(-8).join("\n")));
  };

  // Bounded fan-out: a sliding pool, not a batch barrier, inside the
  // machine-wide sandbox limit.
  const results: PromiseSettledResult<Outcome>[] = [];
  const crashed = new Map<string, string>();
  const queue = [...issues];
  const begun = new Set<string>();
  const calledOff = new Set<string>();
  // The ticket's state once its pipeline ends. A green branch that changes
  // hooks, CI or install scripts says so now: before, a human merge was news
  // only at the end of the run.
  const settled = (o: Outcome): TicketRecord => {
    const repaired = o.repairs ? `, ${o.repairs} repair(s)` : "";
    if (o.status === "green") {
      const held = protectedChanges(project, o.branch);
      if (o.unreviewed) held.push("repair not reviewed");
      return { state: "ready", note: held.length ? `human merge: ${held.join(", ")}` : `gates green${repaired}` };
    }
    if (o.status === "merged-earlier") return { state: "ready", note: `merged earlier (${o.head}) - to close` };
    if (o.status === "gate-failed") return { state: "red", note: `${o.gates.filter((g) => !g.pass).map((g) => g.name).join(", ")} red${repaired}` };
    return { state: "nochange", note: notes.some((n) => n.issue === o.issue && n.kind === "hold") ? "handed back - for a human" : "nothing to change" };
  };
  // What the view and the records say about a finished pipeline. A throw here
  // (a git call, a full disk) would escape the settle handlers and reject the
  // whole pool: every green branch left unlanded for want of a status line.
  const bookkeep = (id: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      console.log(`${ref(id)}: could not record its state (${String(error).split("\n")[0].slice(0, 160)}); its outcome stands.`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, issues.length) }, async () => {
      for (let next = queue.shift(); next && limitHit === undefined && !usageHit && !tampered; next = queue.shift()) {
        const issue = next;
        const stop = await usageStop(env);
        if (stop) {
          usageHit ??= stop;
          break;
        }
        // A tracker that cannot be read is no reason to skip: the check before landing asks again.
        const called = (() => {
          try {
            return withdrawal(issue.id);
          } catch {
            return undefined;
          }
        })();
        if (called) {
          calledOff.add(issue.id);
          run.ticket(issue.id, { state: "withdrawn", note: `${called.reason.replace(" during the run", "")} - not started` });
          continue;
        }
        begun.add(issue.id);
        results.push(
          await withSlot("sandboxes", `${project.name} ${ref(issue.id)}`, () => pipeline(issue)).then(
            (value) => {
              bookkeep(issue.id, () => {
                const tokens = spent.get(issue.id);
                run.ticket(issue.id, {
                  ...settled(value),
                  commits: value.commits,
                  minutes: Math.round((took.get(issue.id) ?? 0) / 60_000),
                  ...(tokens ? { tokens: tokenBrief(tokens) } : {}),
                  ...(value.failing?.length ? { failing: value.failing } : {}),
                });
                run.update({ typical: typicalTimes(project, [...took.values()]) });
                // With nothing left to start, the pane closes: five panes each
                // frozen on a finished agent's summary read as five stuck sandboxes.
                view.finish(issue.id, finishWord(value), queue.length === 0);
                // Recorded now, not only at the report: a branch waiting for
                // landing had no outcome for this run, and its row read as an
                // earlier run's leftover. Landing overwrites it.
                recordOutcomes(project, runId, { [issue.id]: outcomeText(value) });
              });
              return { status: "fulfilled", value } as const;
            },
            (reason) => {
              // The .git check after this ticket's pipeline failed: its work
              // finished, and the whole run stops. Not a crash of the ticket.
              if (stops.has(String(reason))) {
                bookkeep(issue.id, () => {
                  run.ticket(issue.id, { state: "stopped", note: "finished before the run stopped - lands on a later run" });
                  recordOutcomes(project, runId, { [issue.id]: "stopped: the run stopped before landing" });
                  view.finish(issue.id, "stopped");
                });
                return { status: "rejected", reason } as const;
              }
              crashed.set(issue.id, String(reason));
              bookkeep(issue.id, () => {
                run.ticket(issue.id, { state: "crashed", note: String(reason).split("\n")[0].slice(0, 160) });
                // Kept open even at the end of the queue: a crash is for a human to read.
                view.finish(issue.id, "crashed");
                if (hitLimit(issue.id)) limitHit = issue.id;
              });
              return { status: "rejected", reason } as const;
            },
          ),
        );
      }
    }),
  );
  clearInterval(heartbeat);
  const stoppedBy = limitHit !== undefined ? `${ref(limitHit)} hit the plan's usage limit` : (usageHit ?? (tampered ? "the shared .git changed" : undefined));
  for (const i of issues) if (!begun.has(i.id) && !calledOff.has(i.id)) run.ticket(i.id, { state: "skipped", note: `not started: ${stoppedBy ?? "the run stopped"}` });

  // -------------------------------------------------------------------------
  // Phase 3: land the green ones, sequentially, on the host
  // -------------------------------------------------------------------------

  run.update({ stage: "landing" });
  // The run stops: the summary still prints, headed by why - a stack trace was all a
  // stopped run left, and its report then said "Run finished".
  const stopLanding = async (error: unknown, notLanded: Outcome[]) => {
    const why = String((error as Error).message ?? error);
    run.update({ stopped: why });
    // Green before the base moved: finished, and landing on a later run like
    // the ones whose own check failed - not "ready", which says this run lands it.
    for (const r of notLanded) {
      bookkeep(r.issue, () => {
        run.ticket(r.issue, { state: "stopped", note: "finished before the run stopped - lands on a later run" });
        recordOutcomes(project, runId, { [r.issue]: "stopped: the run stopped before landing" });
      });
    }
    console.log(`\n${await closingReport(project)}\n`);
    throw error;
  };
  const greenOutcomes = () =>
    results.flatMap((r) => (r.status === "fulfilled" && (r.value.status === "green" || r.value.status === "merged-earlier") ? [r.value] : []));
  try {
    assertGitUnchanged(project, fingerprint, "before landing");
  } catch (error) {
    await stopLanding(error, greenOutcomes());
  }
  // A branch carried over from an earlier run lands first. In finish order it
  // came last - it had a merge to resolve - and lost a conflict to a new branch
  // of this run on the same lines, run after run. Now the new one conflicts,
  // and its next run merges the base in and lands.
  const green = greenOutcomes().sort((a, b) => Number(!!b.carried) - Number(!!a.carried));
  const gateNames = project.gates.map((g) => g.name).join(", ");
  // Where the branches forked, to tell which merged branch a conflict is with.
  const startBase = sh("git", ["rev-parse", base]);
  const merged: string[] = [];
  // Merged by regenerating generated files in a sandbox: for the close comment, and a tree no gate has seen.
  const regenerated = new Map<string, { files: string[]; regen: string[] }>();
  const conflicted: { issue: string; branch: string; files: string[]; with: string[] }[] = [];
  const heldBack: { issue: string; paths: string[] }[] = [];
  const failedToLand: { issue: string; reason: string }[] = [];
  const skipped: { issue: string; reason: string }[] = [];
  const withdrawn: { issue: string; reason: string }[] = [];
  // Marked needs-human by a person during the run: theirs now, not a merge to make.
  const takenBack: string[] = [];
  const closedEarlier: string[] = [];
  const closeFailed: string[] = [];

  // Each ticket's state as landing decides it, so the view counts landing
  // down rather than showing one opaque stage for minutes.
  const land = (id: string, state: string, note: string) => run.ticket(id, { state, note });
  for (const [at, o] of green.entries()) {
    run.update({ stage: `landing ${at + 1}/${green.length}` });
    run.ticket(o.issue, { state: "landing" });
    // The issue can change during a long run: closed by hand, or sent to a
    // human. Merging then would land work nobody still wants. A gh error here
    // costs this issue, never the landing of every green branch after it.
    try {
      // Someone's decision, not a failure: reported as "not landed", it came
      // back as a branch to fix and merge. A ticket sent to a human is theirs
      // now, its branch there if it helps; one closed or unqueued is done with.
      const called = withdrawal(o.issue);
      if (called?.held) {
        takenBack.push(o.issue);
        land(o.issue, "held", called.reason);
        continue;
      }
      if (called) {
        withdrawn.push({ issue: o.issue, reason: called.reason });
        land(o.issue, "withdrawn", called.reason);
        continue;
      }
      if (o.status === "merged-earlier") {
        if (DRY_RUN) {
          console.log(`[dry run] would close ${ref(o.issue)} - merged by an earlier run (${o.head})`);
          land(o.issue, "ready", "dry run: would close");
          continue;
        }
        tracker.close(o.issue, `Merged into \`${base}\` by an earlier Sandcastle run (${o.head}); closing.`);
        closedEarlier.push(o.issue);
        land(o.issue, "merged", `closed, merged earlier (${o.head})`);
        continue;
      }
    } catch (error) {
      failedToLand.push({ issue: o.issue, reason: errorLine(error) });
      land(o.issue, "not landed", errorLine(error));
      continue;
    }
    // The gates vouched for one commit. Anything added after it is ungated.
    if (sh("git", ["rev-parse", o.branch]) !== o.head) {
      skipped.push({ issue: o.issue, reason: `${o.branch} moved after its gates passed` });
      land(o.issue, "not landed", skipped.at(-1)!.reason);
      continue;
    }
    const touched = protectedChanges(project, o.branch);
    if (touched.length) {
      heldBack.push({ issue: o.issue, paths: touched });
      land(o.issue, "held", `${DRY_RUN ? "dry run: would hold" : "human merge"}: ${touched.join(", ")}`);
      run.ticket(o.issue, { files: touched });
      if (!DRY_RUN) {
        tracker.hold(
          o.issue,
          `Gated green on \`${o.branch}\` (${gateNames}), but not merged automatically: it changes how the repo ` +
            `executes (${touched.join(", ")}), which its own gates cannot vouch for. Review and merge by hand.` +
            (reports.get(o.issue) ? `\n\n${reports.get(o.issue)}` : ""),
        );
      }
      continue;
    }
    if (o.unreviewed) {
      const why = "repair commits not reviewed: the review after repair failed";
      heldBack.push({ issue: o.issue, paths: [] });
      land(o.issue, "held", `${DRY_RUN ? "dry run: would hold" : "human merge"}: ${why}`);
      if (!DRY_RUN) tracker.hold(o.issue, `Gated green on \`${o.branch}\` after a repair, but not merged: ${why}. Review the repair commits and merge by hand.`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`[dry run] would merge ${o.branch} and close ${ref(o.issue)}`);
      land(o.issue, "ready", "dry run: would merge");
      continue;
    }
    try {
      // The commit the gates passed on, not whatever the branch names now.
      mergeBranch(project.root, o.branch, o.head!, ref(o.issue));
      merged.push(o.issue);
    } catch (error) {
      // A real conflict and a merge that failed for another reason (a dirty
      // index, a full disk) are reported apart - calling both "conflict" sent us
      // looking for conflicts that were not there.
      const unmerged = (() => {
        try {
          return sh("git", ["diff", "--name-only", "--diff-filter=U"]);
        } catch {
          return "";
        }
      })();
      try {
        sh("git", ["merge", "--abort"]);
      } catch {
        /* nothing to abort */
      }
      const files = unmerged.split("\n").filter(Boolean);
      // The host never runs project code, so a conflict confined to generated files is
      // redone in a sandbox, where `regen` can run.
      let sandboxed: Awaited<ReturnType<typeof landInSandbox>> | undefined;
      if (unmerged && regensFor(files, project.generated)) {
        try {
          sandboxed = await withSlot("sandboxes", `${project.name} ${ref(o.issue)} land`, () =>
            landInSandbox(project, { branch: o.branch, head: o.head!, message: `Merge ${o.branch} (closes ${ref(o.issue)})` }, sandboxOpener(project, image, planFile)),
          );
        } catch (sandboxError) {
          // The .git check stops the run, as before landing; a sandbox that would not start is a conflict.
          if (sandboxError instanceof OperatorError) return await stopLanding(sandboxError, green.slice(at));
          console.log(`${ref(o.issue)}: could not land it in a sandbox (${errorLine(sandboxError)}); left as a conflict.`);
        }
      }
      if (sandboxed?.kind === "merged") {
        merged.push(o.issue);
        regenerated.set(o.issue, { files: sandboxed.files, regen: sandboxed.regen });
        console.log(
          `${ref(o.issue)}: conflicted only in generated files (${sandboxed.files.join(", ")}); merged by regenerating them with ${sandboxed.regen.map((c) => `\`${c}\``).join(", ")}.`,
        );
      } else if (unmerged) {
        if (sandboxed?.kind === "regen-failed") {
          console.log(`${ref(o.issue)}: regenerating ${sandboxed.files.join(", ")} failed (${sandboxed.reason}); left as a conflict.`);
        }
        // Named, with the branch it collides with: "merge conflict" alone
        // left a human to find both.
        const other = merged.filter((m) => {
          const changed = sh("git", ["diff", "--name-only", `${startBase}...agent/issue-${m}`]).split("\n");
          return files.some((f) => changed.includes(f));
        });
        conflicted.push({ issue: o.issue, branch: o.branch, files, with: other });
        land(o.issue, "conflict", conflictLine(conflicted.at(-1)!));
        run.ticket(o.issue, { files });
        continue;
      } else {
        // git's own last line ("Merge with strategy ort failed.") names no file, and
        // its wording varies by version, so the reason comes from the working tree.
        const dirty = (() => {
          try {
            return dirtyFiles(project.root);
          } catch {
            return [];
          }
        })();
        const reason =
          dirty.length > 0
            ? `working tree dirty: ${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ""} - commit or stash, then run again`
            : errorLine(error);
        failedToLand.push({ issue: o.issue, reason });
        land(o.issue, "not landed", reason);
        continue;
      }
    }
    // The merge stands whatever the tracker says next: a failed close is a
    // merged ticket still open, not one that failed to land - calling it "not
    // landed" sent a human to merge work already on the base branch.
    try {
      tracker.close(
        o.issue,
        closeComment({ ...o, regenerated: regenerated.get(o.issue) }, gateNames, reports.get(o.issue)),
      );
      land(o.issue, "merged", regenerated.has(o.issue) ? "merged and closed (generated files regenerated)" : "merged and closed");
    } catch (error) {
      closeFailed.push(o.issue);
      run.ticket(o.issue, { state: "merged", note: "merged; closing the ticket failed", closeFailed: errorLine(error) });
    }
  }

  // An agent that can write to the tracker (GitHub) hands a ticket back
  // itself - needs-human on, queue label off - and commits nothing, so its
  // pipeline ends as nochange. Reported as "nothing to change", a question
  // for a human read as a ticket that needed no work.
  const handedBack: string[] = [];
  if (tracker.agentsWrite && !DRY_RUN) {
    for (const r of results) {
      if (r.status !== "fulfilled" || r.value.status !== "nochange") continue;
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
  for (const id of new Set([...reports.keys(), ...conflicted.map((c) => c.issue)])) {
    if (merged.includes(id) || closedEarlier.includes(id) || heldBack.some((h) => h.issue === id) || notes.some((n) => n.issue === id)) continue;
    const c = conflicted.find((x) => x.issue === id);
    const text = notLandedComment(reports.get(id), c && { branch: c.branch, base, files: c.files, with: c.with });
    if (text !== undefined) notes.push({ issue: id, kind: "comment", text });
  }
  for (const n of notes) {
    if (DRY_RUN) console.log(`[dry run] would ${n.kind === "hold" ? "hold for a human" : "comment on"} ${ref(n.issue)}: ${n.text.slice(0, 120)}`);
    else {
      try {
        if (n.kind === "hold") tracker.hold(n.issue, n.text);
        else tracker.comment(n.issue, n.text);
      } catch (error) {
        console.log(`Could not update ${ref(n.issue)}: ${errorLine(error)}`);
      }
    }
    if (n.kind === "hold") {
      view.landed(n.issue, false, "needs a human");
      land(n.issue, "held", "handed back - for a human");
    }
  }
  for (const n of merged) view.landed(n, true, closeFailed.includes(n) ? "merged, not closed" : "merged");
  for (const n of closedEarlier) view.landed(n, true, "closed");
  for (const c of conflicted) view.landed(c.issue, false, "merge conflict");
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
  if (merged.length > 1 || regenerated.size > 0) verify = (await timed("", "verify", () => gateBase(project, image, planFile, "verify"))).gates;
  run.update({ stage: "report" });

  // Each branch's outcome, for the status view's rows (run.ts).
  const outcome = new Map<string, string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    outcome.set(r.value.issue, outcomeText(r.value));
  }
  for (const n of merged) outcome.set(n, "merged");
  for (const n of closeFailed) outcome.set(n, "merged (ticket not closed)");
  for (const c of conflicted) outcome.set(c.issue, `merge conflict: ${conflictLine(c)}`);
  for (const f of failedToLand) outcome.set(f.issue, "failed to land");
  for (const k of skipped) outcome.set(k.issue, `not merged: ${k.reason}`);
  for (const w of withdrawn) outcome.set(w.issue, `withdrawn: ${w.reason}`);
  for (const h of heldBack) outcome.set(h.issue, "needs a human merge");
  for (const id of handedBack) outcome.set(id, "needs a human: handed back");
  for (const id of takenBack) outcome.set(id, "needs a human: marked needs-human during the run");
  if (DRY_RUN) for (const o of green) if (o.status === "green") outcome.set(o.issue, "dry run: gated green, would merge");
  for (const [n] of crashed) outcome.set(n, "crashed");
  recordOutcomes(project, runId, Object.fromEntries(outcome));

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  // The detail, one line per issue, for an engineer. The closing summary
  // after it says what to do next (report.ts). The word is each ticket's final
  // state: "shipped" once sat on every branch, held ones included.
  console.log("\n--- per issue ---");
  const final = run.tickets();
  for (const r of results) {
    if (r.status === "rejected") {
      console.log(`  ${stops.has(String(r.reason)) ? "STOPPED" : "CRASHED"}  ${String(r.reason).split("\n")[0].slice(0, 200)}`);
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
  console.log("  logs: .sandcastle/logs/agent-issue-<id>-*.log (moved to logs/archive/ once the branch is merged)");
  if (limitHit !== undefined || usageHit) {
    console.log(`\nSTOPPED EARLY: ${stoppedBy}; ${issues.length - begun.size} queued issue(s) were not started.`);
  }
  let dryRunCheck: string | undefined;
  if (before) {
    const after = tracker.snapshot([...before.keys()].filter((k) => k !== LATEST_ISSUE));
    const changed = [...before].filter(([n, was]) => after.get(n) !== was);
    dryRunCheck = changed.length
      ? `DRY RUN BREACHED: ${changed.map(([n, was]) => `${ref(n)} ${was} -> ${after.get(n)}`).join("; ")} - an agent wrote to the tracker.`
      : `dry run held: ${[...before.keys()].filter((k) => k !== LATEST_ISSUE).length} ticket(s) unchanged in the tracker.`;
  }
  run.update({ verify: verify ? { green: verify.every((g) => g.pass), line: gateLine(verify) } : null, keptWorktrees, dryRunCheck });
  console.log(`\n${await closingReport(project)}\n`);
  view.close(
    `merged ${merged.length}` +
      (conflicted.length + failedToLand.length + skipped.length ? `, not landed ${conflicted.length + failedToLand.length + skipped.length}` : "") +
      (heldBack.length + handedBack.length + takenBack.length ? `, needs a human ${heldBack.length + handedBack.length + takenBack.length}` : "") +
      (withdrawn.length ? `, withdrawn ${withdrawn.length}` : "") +
      ` of ${issues.length}`,
  );
};
