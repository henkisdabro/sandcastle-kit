// The issue-burndown orchestrator, for any project with a `.sandcastle/config.ts`.
//
//   Phase 0  Base    - every gate on the base commit, in the image; a red one
//                      stops the run before any agent starts (gates.ts).
//   Phase 1  Fan out - one sandbox per queued issue, own branch: implement,
//                      review (and optionally cross-review) on the same warm
//                      sandbox.
//   Phase 2  Gate    - the project's gates, run by the ORCHESTRATOR via
//                      exec(), never self-reported by an agent. A red gate
//                      gets a bounded repair pass fed its output.
//   Phase 3  Land    - green branches merge to the base branch; the issue is
//                      closed with a comment. Red branches, and green ones
//                      that change hooks/CI/install scripts, are left standing.
//   Phase 4  Verify  - the gates once more on the merged base branch, because
//                      two branches green on their own can be red together.
//
// Environment: ISSUES=1,2 (instead of the queue label), CONCURRENCY, DRY_RUN=1,
// SANDCASTLE_TEST_RED_GATE=1, SKIP_BASE_GATES=1, plus the model variables in agents.ts and the
// machine-wide limits in pool.ts.

import { createSandbox } from "@ai-hero/sandcastle";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CROSS_REVIEW, MODELS_LINE, crossReview, implAgent, reviewWithFallback } from "./agents.ts";
import type { Project } from "./config.ts";
import { type Gate, gateBase, gateLine, gateMs, requireGreenBase, runGates as gatesIn } from "./gates.ts";
import { blockerResolver, commentBlockLine, commentOnlyBlocks, openBlockers, refLabel } from "./blockers.ts";
import { assertGitUnchanged, disableHostGitHooks, gitFingerprint, lockRun, protectedChanges } from "./guard.ts";
import { checkHooks, hiddenReferences, reportHookCheck, writePlan } from "./lean.ts";
import { IN_HERDR, openSandboxView } from "./herdr.ts";
import { usage, withSlot } from "./pool.ts";
import {
  addTokens, archiveFinishedLogs, assertCleanBase, NO_TOKENS, openStatusPane, preflight, recordOutcomes,
  recordRun, renderPrompts, runTokens, type Tokens, tokenLine, usedArgs, logOwner,
} from "./run.ts";
import { credentials, ensureImage, sandboxConfig, sh } from "./sandbox.ts";
import { makeTracker, type Ticket } from "./tracker.ts";
import { usageLine, usageStop } from "./usage.ts";
import { lockWorktree, releaseBranchWorktree, unlockAll, unlockWorktree } from "./worktree-lock.ts";

type Issue = Ticket;
type Outcome = {
  issue: string;
  branch: string;
  status: "shipped" | "gate-failed" | "nochange" | "merged-earlier";
  commits: number;
  /** The branch tip the gates passed on; landing refuses a branch that moved since. */
  head?: string;
  reviewCommits: number;
  repairs: number;
  gates: Gate[];
};

// What a spent plan allowance leaves at the end of an agent's log.
const LIMIT = /out of usage credits|usage limit|limit reached/i;

// A fence one backtick longer than any run inside, so gate output cannot
// close it and carry on as prompt text.
const fence = (text: string) => {
  const f = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${f}\n${text}\n${f}`;
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
  const CONCURRENCY = Number(process.env.CONCURRENCY ?? project.concurrency);
  const base = project.baseBranch;

  // Fail before spending a single container.
  disableHostGitHooks();
  assertCleanBase(project);
  lockRun(project);

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
  const issues = queued.filter((i) => !waiting.some((w) => w.issue === i.id));
  if (issues.length === 0) {
    console.log("Every queued issue is waiting on another. Nothing to start.");
    return;
  }

  console.log(`${issues.length} issue(s), ${CONCURRENCY} at a time${DRY_RUN ? " [DRY RUN]" : ""} - ${MODELS_LINE}:`);
  for (const i of issues) console.log(`  ${ref(i.id)} ${i.title}`);
  console.log(`Machine-wide: ${usage()}`);
  if (TEST_RED_GATE) {
    console.log(
      "SANDCASTLE_TEST_RED_GATE=1: each issue's first gate run counts as red, to test the repair pass. " +
        "Each issue pays for a repair agent and another full gate run - a test switch, not for real runs.",
    );
  } else if (process.env.SANDCASTLE_TEST_RED_GATE === "1") console.log("SANDCASTLE_TEST_RED_GATE=1 ignored: repair.attempts is 0.");

  // The run is on record and on screen before anything slow starts: a cold
  // image check, preflight and base gates took over three minutes with no
  // view at all, and the chosen issues looked like the rest of the queue.
  // `waiting` lets the status view show a held-back issue as blocked, not queued.
  const run = recordRun(project, { issues: issues.map((i) => i.id), dryRun: DRY_RUN, waiting, stage: "starting" });
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
    throw new Error("Could not open the status view in Herdr - nothing was started. Check `herdr pane list`, or run `sandcastle status` yourself.");
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
  // Each issue's phase and its start go to run.json as well: the status view
  // cannot tell a gate run from the review before it by the logs alone (a
  // gate writes none), and a log's age is how long since its last line, not
  // how long the issue has been at this step.
  const publishActive = () =>
    run.update({
      active: Object.fromEntries(
        [...active].filter(([n]) => n).map(([n, a]) => [n, { phase: a.phase, since: Math.floor(a.since / 1000) }]),
      ),
    });
  const timed = async <T>(issue: string, phase: string, fn: () => Promise<T> | T): Promise<T> => {
    const since = Date.now();
    active.set(issue, { phase, since });
    if (issue) {
      view.phase(issue, phase);
      publishActive();
    } else run.update({ stage: phase });
    let ok = false;
    let tokens: Tokens | undefined;
    let gateTimes: Record<string, number> | undefined;
    try {
      const result = await fn();
      ok = true;
      tokens = runTokens(result);
      gateTimes = gateMs(result);
      if (tokens) spent.set(issue, addTokens(spent.get(issue) ?? NO_TOKENS, tokens));
      return result;
    } finally {
      active.delete(issue);
      if (issue) publishActive();
      const line = {
        ts: new Date().toISOString(), run: runId, project: project.name, issue, phase, ms: Date.now() - since, ok,
        ...(tokens ? { tokens } : {}),
        ...(gateTimes ? { gates: gateTimes } : {}),
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
  if (hookCheck.failures.length) throw new Error("A kept hook cannot run in the image - no sandbox started.");
  if (process.env.SKIP_BASE_GATES === "1") console.log(`SKIP_BASE_GATES=1: the gates on ${base} are not checked first.`);
  else await timed("", "base gates", () => requireGreenBase(project, image, planFile));
  // What the tracker says about each ticket now, to prove a dry run left it alone.
  const before = DRY_RUN ? tracker.snapshot(issues.map((i) => i.id)) : undefined;
  run.update({ stage: "running" });
  const fingerprint = gitFingerprint(project);
  // Set when the shared .git changed under us; no further issue starts.
  let tampered: string | undefined;

  const runGates = (sandbox: Parameters<typeof gatesIn>[1], label: string) => gatesIn(project, sandbox, label);

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

    try {
      // Normally already locked by the worktree hook; this covers a worktree
      // Sandcastle reused.
      lockWorktree(sandbox.worktreePath);
      const impl = await timed(issue.id, "implement", () =>
        sandbox.run({
          name: `impl-${issue.id}`,
          agent: implAgent(),
          promptFile: prompts.implement,
          promptArgs: usedArgs(prompts.implement, promptArgs),
          maxIterations: project.implement.maxIterations ?? 8,
          idleTimeoutSeconds: project.implement.idleTimeoutSeconds ?? 2400,
        }),
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

      // Review passes run on the same warm sandbox and branch. Their commits
      // ride the same gates as the implementer's, so a review that breaks the
      // build cannot merge either. Log names keep `-review-` for status.sh.
      const reviewRun = (name: string) => (agent: Parameters<typeof sandbox.run>[0]["agent"]) =>
        sandbox.run({
          name,
          agent,
          promptFile: prompts.review,
          promptArgs: usedArgs(prompts.review, promptArgs),
          maxIterations: project.review.maxIterations ?? 3,
          idleTimeoutSeconds: project.review.idleTimeoutSeconds ?? 2400,
        });
      const review = await timed(issue.id, "review", () =>
        reviewWithFallback(ref(issue.id), reviewRun(`review-${issue.id}`)),
      );
      const cross = CROSS_REVIEW
        ? await timed(issue.id, "cross-review", () =>
            crossReview(ref(issue.id), reviewRun(`review-codex-${issue.id}`)),
          )
        : undefined;
      const reviewCommits = review.commits.length + (cross?.commits.length ?? 0);
      if (!tracker.agentsWrite) {
        for (const [who, r] of [["Reviewer", review], ["Cross-reviewer", cross]] as const) {
          const said = r && tags(r.stdout).report;
          if (said) addReport(issue.id, who, said);
        }
      }

      // Gates are checked here, in the orchestrator. No agent gets to tell us
      // they passed - `exitCode` is returned rather than thrown.
      let gated = await timed(issue.id, "gates", () => runGates(sandbox, `${ref(issue.id)} gates`));
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
      // the same protected-path check; they are not reviewed again, because
      // the repair prompt forbids exactly what a review would catch here
      // (weakened tests, removed guards). Not after a timeout (124): a hung
      // gate leaves nothing to repair from and would hang again.
      let repairs = 0;
      for (let red = gated.failure; red && red.exitCode !== 124 && repairs < (project.repair.attempts ?? 1); red = gated.failure) {
        const failure = red;
        repairs++;
        console.log(
          `${ref(issue.id)}: ${forced ? `test red gate (SANDCASTLE_TEST_RED_GATE; ${failure.name} passed)` : `${failure.name} red`} - repair pass ${repairs}`,
        );
        forced = false;
        // A repair that dies (idle timeout, agent exit) leaves the branch red,
        // not the issue crashed: the gate results stay in the report. A spent
        // allowance still has to stop the queue, so that one is rethrown.
        const fixed = await timed(issue.id, "repair", () =>
          sandbox.run({
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
          }),
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
        gated = await timed(issue.id, "gates", () => runGates(sandbox, `${ref(issue.id)} gates`));
      }

      return {
        issue: issue.id,
        branch,
        status: gated.failure ? "gate-failed" : "shipped",
        // Branch total, so a re-run of an already-implemented branch does not
        // report 0 commits while shipping its work.
        commits: Number(sh("git", ["rev-list", "--count", `${base}..${branch}`])),
        reviewCommits,
        repairs,
        gates: gated.gates,
        head: sh("git", ["rev-parse", branch]),
      };
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
        tampered = String(error);
        throw error;
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
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, issues.length) }, async () => {
      for (let next = queue.shift(); next && limitHit === undefined && !usageHit && !tampered; next = queue.shift()) {
        const issue = next;
        const stop = await usageStop(env);
        if (stop) {
          usageHit ??= stop;
          break;
        }
        results.push(
          await withSlot("sandboxes", `${project.name} ${ref(issue.id)}`, () => pipeline(issue)).then(
            (value) => {
              view.finish(issue.id, value.status);
              return { status: "fulfilled", value } as const;
            },
            (reason) => {
              view.finish(issue.id, "crashed");
              crashed.set(issue.id, String(reason));
              if (hitLimit(issue.id)) limitHit = issue.id;
              return { status: "rejected", reason } as const;
            },
          ),
        );
      }
    }),
  );
  clearInterval(heartbeat);

  // -------------------------------------------------------------------------
  // Phase 3: land the green ones, sequentially, on the host
  // -------------------------------------------------------------------------

  run.update({ stage: "landing" });
  assertGitUnchanged(project, fingerprint, "before landing");
  const green = results.flatMap((r) =>
    r.status === "fulfilled" && (r.value.status === "shipped" || r.value.status === "merged-earlier") ? [r.value] : [],
  );
  const gateNames = project.gates.map((g) => g.name).join(", ");
  const merged: string[] = [];
  const conflicted: string[] = [];
  const heldBack: { issue: string; paths: string[] }[] = [];
  const failedToLand: { issue: string; reason: string }[] = [];
  const skipped: { issue: string; reason: string }[] = [];
  const closedEarlier: string[] = [];

  for (const o of green) {
    // The issue can change during a long run: closed by hand, or sent to a
    // human. Merging then would land work nobody still wants. A gh error here
    // costs this issue, never the landing of every green branch after it.
    try {
      const now = tracker.get(o.issue);
      // A ticket someone moved to another status mid-run (files) is no longer
      // the queue's to land, whatever the new status is called.
      const startedAs = issues.find((i) => i.id === o.issue)?.status;
      const moved = startedAs !== undefined && now.status !== startedAs;
      if (!now.open || now.held || moved) {
        skipped.push({
          issue: o.issue,
          reason: !now.open ? "ticket is closed" : now.held ? "marked needs-human" : `status changed from ${startedAs} to ${now.status} during the run`,
        });
        continue;
      }
      if (o.status === "merged-earlier") {
        if (DRY_RUN) {
          console.log(`[dry run] would close ${ref(o.issue)} - merged by an earlier run (${o.head})`);
          continue;
        }
        tracker.close(o.issue, `Merged into \`${base}\` by an earlier Sandcastle run (${o.head}); closing.`);
        closedEarlier.push(o.issue);
        continue;
      }
    } catch (error) {
      failedToLand.push({ issue: o.issue, reason: String(error).slice(0, 200) });
      continue;
    }
    // The gates vouched for one commit. Anything added after it is ungated.
    if (sh("git", ["rev-parse", o.branch]) !== o.head) {
      skipped.push({ issue: o.issue, reason: `${o.branch} moved after its gates passed` });
      continue;
    }
    const touched = protectedChanges(project, o.branch);
    if (touched.length) {
      heldBack.push({ issue: o.issue, paths: touched });
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
    if (DRY_RUN) {
      console.log(`[dry run] would merge ${o.branch} and close ${ref(o.issue)}`);
      continue;
    }
    try {
      // --no-verify: a pre-commit hook re-running what the gates covered only
      // adds a way for a green branch to fail to land. (Hooks are off for the
      // whole host process anyway - see guard.ts.)
      // The commit the gates passed on, not whatever the branch names now.
      sh("git", ["merge", "--no-ff", "--no-verify", "-m", `Merge ${o.branch} (closes ${ref(o.issue)})`, o.head!]);
      merged.push(o.issue);
      // Close before unlabelling: a run that dies between the two leaves a
      // closed issue with a stale label (harmless - the queue lists open
      // issues only), where the other order left an open, unlabelled,
      // merged issue that no later run would ever list again.
      tracker.close(
        o.issue,
        `Shipped by the Sandcastle loop on \`${o.branch}\` (${o.commits} commit(s)` +
          (o.repairs ? `, ${o.repairs} repair pass(es) after a red gate` : "") +
          `); ${gateNames} all green before merge.` +
          (reports.get(o.issue) ? `\n\n${reports.get(o.issue)}` : ""),
      );
    } catch (error) {
      // A real conflict and a merge that failed for another reason (a hook, a
      // gh API error) are reported apart - calling both "conflict" sent us
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
      if (unmerged) conflicted.push(o.issue);
      else failedToLand.push({ issue: o.issue, reason: String(error).slice(0, 200) });
    }
  }

  // Whatever the agents said about a ticket that did not land (red gate,
  // conflict, nothing to change) would otherwise live only in an archived log.
  for (const [id, text] of reports) {
    if (merged.includes(id) || closedEarlier.includes(id) || heldBack.some((h) => h.issue === id) || notes.some((n) => n.issue === id)) continue;
    notes.push({ issue: id, kind: "comment", text: `Sandcastle ran this ticket and did not land it. What the agents reported:\n\n${text}` });
  }
  for (const n of notes) {
    if (DRY_RUN) console.log(`[dry run] would ${n.kind === "hold" ? "hold for a human" : "comment on"} ${ref(n.issue)}: ${n.text.slice(0, 120)}`);
    else {
      try {
        if (n.kind === "hold") tracker.hold(n.issue, n.text);
        else tracker.comment(n.issue, n.text);
      } catch (error) {
        console.log(`Could not update ${ref(n.issue)}: ${String(error).slice(0, 160)}`);
      }
    }
    if (n.kind === "hold") view.landed(n.issue, false, "needs a human");
  }
  for (const n of merged) view.landed(n, true, "merged");
  for (const n of closedEarlier) view.landed(n, true, "closed");
  for (const n of conflicted) view.landed(n, false, "merge conflict");
  for (const f of failedToLand) view.landed(f.issue, false, "failed to land");
  for (const k of skipped) view.landed(k.issue, false, "not merged");
  for (const h of heldBack) view.landed(h.issue, false, "needs a human");

  // -------------------------------------------------------------------------
  // Phase 4: the gates on the merged base branch. Each branch was gated on its
  // own; together they can still be red.
  // -------------------------------------------------------------------------

  let verify: Gate[] | undefined;
  if (merged.length > 1) verify = (await timed("", "verify", () => gateBase(project, image, planFile, "verify"))).gates;
  run.update({ stage: "report" });

  // Each branch's outcome, for the status view's rows (run.ts).
  const outcome = new Map<string, string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const o = r.value;
    outcome.set(o.issue, o.status === "gate-failed" ? `gate red: ${gateLine(o.gates.filter((g) => !g.pass))}` : o.status);
  }
  for (const n of merged) outcome.set(n, "merged");
  for (const n of conflicted) outcome.set(n, "merge conflict");
  for (const f of failedToLand) outcome.set(f.issue, "failed to land");
  for (const k of skipped) outcome.set(k.issue, `not merged: ${k.reason}`);
  for (const h of heldBack) outcome.set(h.issue, "needs a human merge");
  if (DRY_RUN) for (const o of green) if (outcome.get(o.issue) === "shipped") outcome.set(o.issue, "dry run: gated green, would merge");
  for (const [n] of crashed) outcome.set(n, "crashed");
  recordOutcomes(project, runId, Object.fromEntries(outcome));

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  console.log("\n--- run report ---");
  for (const r of results) {
    if (r.status === "rejected") {
      console.log(`  CRASHED  ${r.reason}`);
      continue;
    }
    const o = r.value;
    const g = gateLine(o.gates);
    const repaired = o.repairs ? ` repaired=${o.repairs}` : "";
    const time = took.has(o.issue) ? ` ${minutes(took.get(o.issue)!)}` : "";
    const cost = spent.has(o.issue) ? `  tokens ${tokenLine(spent.get(o.issue)!)}` : "";
    console.log(`  ${ref(o.issue)} ${o.status.padEnd(14)} commits=${o.commits} (review=${o.reviewCommits})${repaired} ${g}${time}  ${o.branch}${cost}`);
  }
  const total = [...spent.values()].reduce(addTokens, NO_TOKENS);
  if (spent.size) console.log(`  all agents: tokens ${tokenLine(total)} (per phase in .sandcastle/logs/timings.jsonl)`);
  console.log(`\nmerged & closed: ${merged.join(", ") || "none"}`);
  if (closedEarlier.length) console.log(`closed, merged by an earlier run: ${closedEarlier.join(", ")}`);
  if (conflicted.length) console.log(`merge conflicts: ${conflicted.join(", ")}`);
  for (const h of heldBack) console.log(`held for a human merge: ${ref(h.issue)} - changes ${h.paths.join(", ")}`);
  for (const f of failedToLand) console.log(`gated green but failed to land: ${ref(f.issue)} - ${f.reason}`);
  for (const k of skipped) console.log(`gated green but not merged: ${ref(k.issue)} - ${k.reason}`);
  if (verify) {
    const ok = verify.every((g) => g.pass);
    console.log(
      `merged ${base} re-gated: ${gateLine(verify)}` +
        (ok ? "" : ` - RED TOGETHER: do not push ${base} until this is fixed`),
    );
  }
  if (limitHit !== undefined) {
    const skipped = issues.length - results.length;
    console.log(`\nSTOPPED EARLY: ${ref(limitHit)} hit the plan's usage limit; ${skipped} queued issue(s) were not started.`);
  } else if (usageHit) {
    console.log(`\nSTOPPED EARLY: ${usageHit}; ${issues.length - results.length} queued issue(s) were not started.`);
  }
  for (const w of waiting) console.log(`waiting, not started: ${ref(w.issue)} - on ${w.on.join(", ")}`);
  for (const k of keptWorktrees) {
    console.log(`worktree kept with uncommitted files: ${ref(k.issue)} - ${k.path} (inspect, then \`git worktree remove --force\` it)`);
  }
  if (before) {
    const after = tracker.snapshot([...before.keys()]);
    const changed = [...before].filter(([n, was]) => after.get(n) !== was);
    console.log(
      changed.length
        ? `DRY RUN BREACHED: ${changed.map(([n, was]) => `${ref(n)} ${was} -> ${after.get(n)}`).join("; ")} - an agent wrote to the tracker.`
        : `dry run held: ${before.size} ticket(s) unchanged in the tracker.`,
    );
  }
  console.log("Branches left standing for review are not deleted (`sandcastle clean` lists them). Nothing is pushed.");
  view.close(
    `merged ${merged.length}` +
      (conflicted.length + failedToLand.length + skipped.length ? `, not landed ${conflicted.length + failedToLand.length + skipped.length}` : "") +
      (heldBack.length ? `, needs a human ${heldBack.length}` : "") +
      ` of ${issues.length}`,
  );
};
