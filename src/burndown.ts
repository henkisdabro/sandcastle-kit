// The issue-burndown orchestrator, for any project with a `.sandcastle/config.ts`.
//
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
// plus the model variables in agents.ts and the machine-wide limits in pool.ts.

import { createSandbox } from "@ai-hero/sandcastle";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CROSS_REVIEW, MODELS_LINE, crossReview, implAgent, reviewWithFallback } from "./agents.ts";
import type { Project } from "./config.ts";
import { assertGitUnchanged, disableHostGitHooks, gitFingerprint, lockRun, protectedChanges } from "./guard.ts";
import { checkHooks, hiddenReferences, plan as leanPlan, reportHookCheck } from "./lean.ts";
import { openSandboxView } from "./herdr.ts";
import { usage, withSlot } from "./pool.ts";
import { archiveFinishedLogs, assertCleanBase, openStatusPane, preflight, recordRun, renderPrompts } from "./run.ts";
import { credentials, ensureImage, sandboxConfig, sh } from "./sandbox.ts";
import { usageLine, usageStop } from "./usage.ts";
import { execGate, lockWorktree, releaseBranchWorktree, unlockWorktree } from "./worktree-lock.ts";

type Issue = { number: number; title: string; body?: string };
type Gate = { name: string; pass: boolean };
type GateRun = { gates: Gate[]; failure?: { name: string; command: string; exitCode: number; output: string } };
type Outcome = {
  issue: number;
  branch: string;
  status: "shipped" | "gate-failed" | "nochange" | "merged-earlier";
  commits: number;
  /** The branch tip the gates passed on; landing refuses a branch that moved since. */
  head?: string;
  reviewCommits: number;
  repairs: number;
  gates: Gate[];
};

// "Blocked by #12", "Depends on: #12" and the like, in an issue body.
const DEPENDENCY = /(?:blocked by|depends on):?\s+#(\d+)/gi;

// What a spent plan allowance leaves at the end of an agent's log.
const LIMIT = /out of usage credits|usage limit|limit reached/i;

// Start and end of a gate's output: the first compiler error is at the top,
// the test summary at the bottom, and a whole log would swamp the prompt.
const clip = (text: string, head = 8_000, tail = 24_000) =>
  text.length <= head + tail
    ? text
    : `${text.slice(0, head)}\n[... ${text.length - head - tail} characters cut ...]\n${text.slice(-tail)}`;

// A fence one backtick longer than any run inside, so gate output cannot
// close it and carry on as prompt text.
const fence = (text: string) => {
  const f = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${f}\n${text}\n${f}`;
};

export const burndown = async (project: Project) => {
  const DRY_RUN = process.env.DRY_RUN === "1";
  // Four by default, not one-per-issue. Twelve at once saturated a 15-core
  // machine to load 33 and starved a vitest run into a false gate failure -
  // good work withheld by resource contention rather than by a defect.
  const CONCURRENCY = Number(process.env.CONCURRENCY ?? project.concurrency);
  const base = project.baseBranch;

  // Fail before spending a single container.
  disableHostGitHooks();
  assertCleanBase(project);
  lockRun(project);

  // The work list lives in GitHub labels, never in an agent's context. Named
  // issues are checked on the host, so a typo or a closed issue fails here and
  // not inside a sandbox that has already installed its dependencies.
  const queued: Issue[] = process.env.ISSUES
    ? process.env.ISSUES.split(",").map((n) => {
        const i = JSON.parse(sh("gh", ["issue", "view", n.trim(), "--json", "number,title,state,body"]));
        if (i.state !== "OPEN") throw new Error(`#${i.number} is ${i.state.toLowerCase()}.`);
        return { number: i.number, title: i.title, body: i.body };
      })
    : JSON.parse(
        sh("gh", ["issue", "list", "--state", "open", "--label", project.label, "--limit", "100", "--json", "number,title,body"]),
      );
  if (queued.length === 0) {
    console.log(`No ${project.label} issues. Queue drained.`);
    return;
  }

  // An issue whose dependency is still open waits - including a dependency
  // in this same run, which cannot be on base before landing, so the
  // dependent would branch without it. The next run picks it up. A
  // dependency that cannot be read counts as open: guessing wrong there
  // starts work on a missing foundation. The issues API also answers for a
  // pull request (`closed` once merged), where `gh issue view` does not.
  const depState = new Map<number, string>();
  const openDependencies = (issue: Issue) =>
    [...new Set([...(issue.body ?? "").matchAll(DEPENDENCY)].map((m) => Number(m[1])))].filter((d) => {
      if (!depState.has(d)) {
        try {
          depState.set(d, sh("gh", ["api", `repos/{owner}/{repo}/issues/${d}`, "--jq", ".state"]));
        } catch {
          depState.set(d, "unreadable");
        }
      }
      return depState.get(d) !== "closed";
    });
  const waiting = queued.flatMap((i) => {
    const on = openDependencies(i);
    return on.length ? [{ issue: i.number, on }] : [];
  });
  for (const w of waiting) console.log(`  #${w.issue} waits for ${w.on.map((d) => `#${d}`).join(", ")} to close`);
  const issues = queued.filter((i) => !waiting.some((w) => w.issue === i.number));
  if (issues.length === 0) {
    console.log("Every queued issue is waiting on another. Nothing to start.");
    return;
  }

  console.log(`${issues.length} issue(s), ${CONCURRENCY} at a time${DRY_RUN ? " [DRY RUN]" : ""} - ${MODELS_LINE}:`);
  for (const i of issues) console.log(`  #${i.number} ${i.title}`);
  console.log(`Machine-wide: ${usage()}`);

  const image = ensureImage(project);
  const prompts = renderPrompts(project);
  preflight(project, image);
  const env = credentials(project);
  const usageNote = await usageLine(env);
  if (usageNote) console.log(usageNote);
  archiveFinishedLogs(project);
  // Written next to the prompts; the worktree hook applies it to each sandbox.
  const lean = leanPlan(project);
  const planFile = join(project.root, ".sandcastle/.run/lean-plan.json");
  writeFileSync(planFile, JSON.stringify(lean, null, 2));
  const kept = lean.items.filter((i) => i.kept && i.kind !== "hook").map((i) => `${i.kind}:${i.id}`);
  const dropped = lean.items.filter((i) => i.kind === "hook" && !i.kept).length;
  console.log(
    `Lean: hiding ${lean.items.filter((i) => !i.kept && i.kind !== "hook").length} item(s) the repo would load` +
      (kept.length ? `; keeping ${kept.join(", ")}` : "") +
      `; ${lean.hooks.length} hook(s) kept${dropped ? `, ${dropped} dropped by lean.dropHooks` : ""} (\`sandcastle lean\` for detail).`,
  );
  const refs = hiddenReferences(project.root, lean);
  if (refs.length) {
    console.log(
      `Lean warning: ${refs.length} hidden item(s) are named by files the sandbox keeps (${refs.map((r) => r.path).join(", ")}). ` +
        "If a gate reads one, it fails on every branch - see `sandcastle lean`.",
    );
  }
  // A kept hook that cannot run fails on every tool call of every agent, or
  // silently guards nothing. Stop before any sandbox starts.
  const hookCheck = checkHooks(project, image, lean);
  reportHookCheck(hookCheck, lean.hooks.length);
  if (hookCheck.failures.length) throw new Error("A kept hook cannot run in the image - no sandbox started.");
  // `waiting` lets the status view show a held-back issue as blocked, not queued.
  recordRun(project, { issues: issues.map((i) => i.number), dryRun: DRY_RUN, waiting });
  openStatusPane(project);
  // One Herdr pane per concurrent sandbox, reporting each one's phase.
  const view = openSandboxView(project, Math.min(CONCURRENCY, issues.length));
  const fingerprint = gitFingerprint(project);
  // Set when the shared .git changed under us; no further issue starts.
  let tampered: string | undefined;

  const runGates = (sandbox: Parameters<typeof execGate>[0], label: string) =>
    withSlot("gates", label, async (): Promise<GateRun> => {
      const gates: Gate[] = [];
      for (const g of project.gates) {
        const r = await execGate(sandbox, g.command);
        gates.push({ name: g.name, pass: r.exitCode === 0 });
        if (r.exitCode !== 0) {
          const output = clip([r.stdout, r.stderr].filter(Boolean).join("\n").trim());
          return { gates, failure: { name: g.name, command: g.command, exitCode: r.exitCode, output } };
        }
      }
      return { gates };
    });

  // Every agent pass and gate run is timed into logs/timings.jsonl, so how
  // long a project's issues take - and where the time goes - is on record
  // rather than guessed. The same map drives the heartbeat below.
  const runId = new Date().toISOString();
  const timings = join(project.root, ".sandcastle/logs/timings.jsonl");
  const active = new Map<number, { phase: string; since: number }>();
  const took = new Map<number, number>();
  const keptWorktrees: { issue: number; path: string }[] = [];
  const timed = async <T>(issue: number, phase: string, fn: () => Promise<T>): Promise<T> => {
    const since = Date.now();
    active.set(issue, { phase, since });
    view.phase(issue, phase);
    let ok = false;
    try {
      const result = await fn();
      ok = true;
      return result;
    } finally {
      active.delete(issue);
      const line = { ts: new Date().toISOString(), run: runId, project: project.name, issue, phase, ms: Date.now() - since, ok };
      appendFileSync(timings, JSON.stringify(line) + "\n");
    }
  };
  const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

  // A run is silent for as long as its agents are, which for a review can be
  // half an hour. One line every five minutes says it is alive and where.
  const heartbeat = setInterval(() => {
    if (!active.size) return;
    const now = Date.now();
    const clock = new Date().toTimeString().slice(0, 5);
    console.log(`[${clock}] working: ${[...active].map(([n, a]) => `#${n} ${a.phase} ${minutes(now - a.since)}`).join(", ")}`);
  }, 5 * 60_000);
  heartbeat.unref();

  // A run that died between merging a branch and closing its issue leaves the
  // issue queued with its work already on base. Re-running it finds nothing
  // to do and reports `nochange`, so the issue would stay open for good. Our
  // own merge message finds it instead - unless someone reopened the issue
  // after that merge, which asks for more work, not for a close. Any doubt
  // (gh unreachable) means a normal run, which is what happened before.
  const mergedEarlier = (issue: number, branch: string) => {
    const found = sh("git", ["log", base, "-1", "--format=%h %cI", "--fixed-strings", `--grep=Merge ${branch} (closes #${issue})`]);
    if (!found) return undefined;
    const [merge, mergedAt] = found.split(" ");
    try {
      const reopens = sh("gh", [
        "api", "--paginate", `repos/{owner}/{repo}/issues/${issue}/events`, "--jq", '.[] | select(.event == "reopened") | .created_at',
      ]);
      const reopenedSince = reopens.split("\n").some((t) => t && Date.parse(t) > Date.parse(mergedAt));
      return reopenedSince ? undefined : merge;
    } catch {
      return undefined;
    }
  };

  // -------------------------------------------------------------------------
  // Phase 1 + 2: implement, review, gate - one pipeline per issue
  // -------------------------------------------------------------------------

  const pipeline = async (issue: Issue): Promise<Outcome> => {
    const branch = `agent/issue-${issue.number}`;
    const promptArgs = { ISSUE_NUMBER: String(issue.number) };
    const merge = mergedEarlier(issue.number, branch);
    if (merge) {
      return { issue: issue.number, branch, status: "merged-earlier", commits: 0, reviewCommits: 0, repairs: 0, gates: [], head: merge };
    }
    view.claim(issue.number, issue.title);

    const started = Date.now();
    releaseBranchWorktree(branch);
    const sandbox = await timed(issue.number, "setup", () =>
      createSandbox({ branch, baseBranch: base, ...sandboxConfig(project, image, planFile) }),
    );

    try {
      // Normally already locked by the worktree hook; this covers a worktree
      // Sandcastle reused.
      lockWorktree(sandbox.worktreePath);
      const impl = await timed(issue.number, "implement", () =>
        sandbox.run({
          name: `impl-${issue.number}`,
          agent: implAgent(),
          promptFile: prompts.implement,
          promptArgs,
          maxIterations: project.implement.maxIterations ?? 8,
          idleTimeoutSeconds: project.implement.idleTimeoutSeconds ?? 2400,
        }),
      );

      // `impl.commits` counts what THIS run added, which is zero in two very
      // different cases: the agent found nothing to do, and the agent found the
      // work already done on the branch from an earlier run. Only the first is
      // `nochange`. How far the branch is ahead of the base tells them apart -
      // without it, a branch whose review died could never be reviewed by
      // re-running the issue: it came straight back as `nochange` with the work
      // still standing, unreviewed and unmerged.
      const branchCommits = Number(sh("git", ["rev-list", "--count", `${base}..${branch}`]));
      if (impl.commits.length === 0 && branchCommits === 0) {
        return { issue: issue.number, branch, status: "nochange", commits: 0, reviewCommits: 0, repairs: 0, gates: [] };
      }

      // Review passes run on the same warm sandbox and branch. Their commits
      // ride the same gates as the implementer's, so a review that breaks the
      // build cannot merge either. Log names keep `-review-` for status.sh.
      const reviewRun = (name: string) => (agent: Parameters<typeof sandbox.run>[0]["agent"]) =>
        sandbox.run({
          name,
          agent,
          promptFile: prompts.review,
          promptArgs,
          maxIterations: project.review.maxIterations ?? 3,
          idleTimeoutSeconds: project.review.idleTimeoutSeconds ?? 2400,
        });
      const review = await timed(issue.number, "review", () =>
        reviewWithFallback(`#${issue.number}`, reviewRun(`review-${issue.number}`)),
      );
      const cross = CROSS_REVIEW
        ? await timed(issue.number, "cross-review", () =>
            crossReview(`#${issue.number}`, reviewRun(`review-codex-${issue.number}`)),
          )
        : undefined;
      const reviewCommits = review.commits.length + (cross?.commits.length ?? 0);

      // Gates are checked here, in the orchestrator. No agent gets to tell us
      // they passed - `exitCode` is returned rather than thrown.
      let gated = await timed(issue.number, "gates", () => runGates(sandbox, `#${issue.number} gates`));

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
        console.log(`#${issue.number}: ${failure.name} red - repair pass ${repairs}`);
        // A repair that dies (idle timeout, agent exit) leaves the branch red,
        // not the issue crashed: the gate results stay in the report. A spent
        // allowance still has to stop the queue, so that one is rethrown.
        const fixed = await timed(issue.number, "repair", () =>
          sandbox.run({
            name: `repair-${issue.number}`,
            agent: implAgent(),
            promptFile: prompts.repair,
            promptArgs: {
              ...promptArgs,
              GATE_NAME: failure.name,
              GATE_COMMAND: failure.command,
              GATE_OUTPUT: fence(failure.output),
            },
            maxIterations: project.repair.maxIterations ?? 4,
            idleTimeoutSeconds: project.repair.idleTimeoutSeconds ?? 2400,
          }),
        ).then(
          () => true,
          (error) => {
            if (hitLimit(issue.number)) throw error;
            console.log(`#${issue.number}: repair pass failed (${String(error).slice(0, 120)}); leaving the branch red.`);
            return false;
          },
        );
        if (!fixed) break;
        gated = await timed(issue.number, "gates", () => runGates(sandbox, `#${issue.number} gates`));
      }

      return {
        issue: issue.number,
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
      took.set(issue.number, Date.now() - started);
      unlockWorktree(sandbox.worktreePath);
      // Sandcastle keeps a worktree with uncommitted files rather than lose
      // them. Say so, or it lingers unexplained in .sandcastle/worktrees/.
      const closed = await sandbox.close();
      if (closed.preservedWorktreePath) keptWorktrees.push({ issue: issue.number, path: closed.preservedWorktreePath });
      try {
        assertGitUnchanged(project, fingerprint, `after #${issue.number}`);
      } catch (error) {
        tampered = String(error);
        throw error;
      }
    }
  };

  // A spent plan allowance fails every issue after it the same way, each one
  // after paying for a sandbox and an install. The first one stops the queue.
  let limitHit: number | undefined;
  let usageHit: string | undefined;
  const hitLimit = (issue: number) => {
    const logs = join(project.root, ".sandcastle/logs");
    if (!existsSync(logs)) return false;
    return readdirSync(logs)
      .filter((f) => f.startsWith(`agent-issue-${issue}-`) && f.endsWith(".log"))
      .some((f) => LIMIT.test(readFileSync(join(logs, f), "utf8").split("\n").slice(-8).join("\n")));
  };

  // Bounded fan-out: a sliding pool, not a batch barrier, inside the
  // machine-wide sandbox limit.
  const results: PromiseSettledResult<Outcome>[] = [];
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
          await withSlot("sandboxes", `${project.name} #${issue.number}`, () => pipeline(issue)).then(
            (value) => {
              view.finish(issue.number, value.status);
              return { status: "fulfilled", value } as const;
            },
            (reason) => {
              view.finish(issue.number, "crashed");
              if (hitLimit(issue.number)) limitHit = issue.number;
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

  assertGitUnchanged(project, fingerprint, "before landing");
  const green = results.flatMap((r) =>
    r.status === "fulfilled" && (r.value.status === "shipped" || r.value.status === "merged-earlier") ? [r.value] : [],
  );
  const gateNames = project.gates.map((g) => g.name).join(", ");
  const merged: number[] = [];
  const conflicted: number[] = [];
  const heldBack: { issue: number; paths: string[] }[] = [];
  const failedToLand: { issue: number; reason: string }[] = [];
  const skipped: { issue: number; reason: string }[] = [];
  const closedEarlier: number[] = [];

  for (const o of green) {
    // The issue can change during a long run: closed by hand, or sent to a
    // human. Merging then would land work nobody still wants. A gh error here
    // costs this issue, never the landing of every green branch after it.
    try {
      const now = JSON.parse(sh("gh", ["issue", "view", String(o.issue), "--json", "state,labels"])) as {
        state: string;
        labels: { name: string }[];
      };
      if (now.state !== "OPEN" || now.labels.some((l) => l.name === "needs-human")) {
        skipped.push({ issue: o.issue, reason: now.state !== "OPEN" ? `issue is ${now.state.toLowerCase()}` : "labelled needs-human" });
        continue;
      }
      if (o.status === "merged-earlier") {
        if (DRY_RUN) {
          console.log(`[dry run] would close #${o.issue} - merged by an earlier run (${o.head})`);
          continue;
        }
        sh("gh", ["issue", "close", String(o.issue), "--comment", `Merged into \`${base}\` by an earlier Sandcastle run (${o.head}); closing.`]);
        sh("gh", ["issue", "edit", String(o.issue), "--remove-label", project.label]);
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
        sh("gh", ["label", "create", "needs-human", "--color", "D93F0B", "--force"]);
        sh("gh", ["issue", "edit", String(o.issue), "--remove-label", project.label, "--add-label", "needs-human"]);
        sh("gh", [
          "issue", "comment", String(o.issue), "--body",
          `Gated green on \`${o.branch}\` (${gateNames}), but not merged automatically: it changes how the repo ` +
            `executes (${touched.join(", ")}), which its own gates cannot vouch for. Review and merge by hand.`,
        ]);
      }
      continue;
    }
    if (DRY_RUN) {
      console.log(`[dry run] would merge ${o.branch} and close #${o.issue}`);
      continue;
    }
    try {
      // --no-verify: a pre-commit hook re-running what the gates covered only
      // adds a way for a green branch to fail to land. (Hooks are off for the
      // whole host process anyway - see guard.ts.)
      // The commit the gates passed on, not whatever the branch names now.
      sh("git", ["merge", "--no-ff", "--no-verify", "-m", `Merge ${o.branch} (closes #${o.issue})`, o.head!]);
      merged.push(o.issue);
      // Close before unlabelling: a run that dies between the two leaves a
      // closed issue with a stale label (harmless - the queue lists open
      // issues only), where the other order left an open, unlabelled,
      // merged issue that no later run would ever list again.
      sh("gh", [
        "issue", "close", String(o.issue), "--comment",
        `Shipped by the Sandcastle loop on \`${o.branch}\` (${o.commits} commit(s)` +
          (o.repairs ? `, ${o.repairs} repair pass(es) after a red gate` : "") +
          `); ${gateNames} all green before merge.`,
      ]);
      // A closed issue must leave the queue too, or it lingers as work that
      // is still waiting for an agent.
      sh("gh", ["issue", "edit", String(o.issue), "--remove-label", project.label]);
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
  if (merged.length > 1) {
    const branch = `sandcastle/verify-${Date.now()}`;
    verify = await withSlot("sandboxes", `${project.name} verify`, async () => {
      const sandbox = await createSandbox({ branch, baseBranch: base, ...sandboxConfig(project, image, planFile) });
      try {
        return (await timed(0, "verify", () => runGates(sandbox, `${project.name} verify gates`))).gates;
      } finally {
        unlockWorktree(sandbox.worktreePath);
        await sandbox.close();
        try {
          sh("git", ["branch", "-D", branch]);
        } catch {
          /* never created */
        }
      }
    });
  }

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
    const g = o.gates.map((x) => `${x.name}=${x.pass ? "pass" : "FAIL"}`).join(" ");
    const repaired = o.repairs ? ` repaired=${o.repairs}` : "";
    const time = took.has(o.issue) ? ` ${minutes(took.get(o.issue)!)}` : "";
    console.log(`  #${o.issue} ${o.status.padEnd(14)} commits=${o.commits} (review=${o.reviewCommits})${repaired} ${g}${time}  ${o.branch}`);
  }
  console.log(`\nmerged & closed: ${merged.join(", ") || "none"}`);
  if (closedEarlier.length) console.log(`closed, merged by an earlier run: ${closedEarlier.join(", ")}`);
  if (conflicted.length) console.log(`merge conflicts: ${conflicted.join(", ")}`);
  for (const h of heldBack) console.log(`held for a human merge: #${h.issue} - changes ${h.paths.join(", ")}`);
  for (const f of failedToLand) console.log(`gated green but failed to land: #${f.issue} - ${f.reason}`);
  for (const k of skipped) console.log(`gated green but not merged: #${k.issue} - ${k.reason}`);
  if (verify) {
    const ok = verify.every((g) => g.pass);
    console.log(
      `merged ${base} re-gated: ${verify.map((g) => `${g.name}=${g.pass ? "pass" : "FAIL"}`).join(" ")}` +
        (ok ? "" : ` - RED TOGETHER: do not push ${base} until this is fixed`),
    );
  }
  if (limitHit !== undefined) {
    const skipped = issues.length - results.length;
    console.log(`\nSTOPPED EARLY: #${limitHit} hit the plan's usage limit; ${skipped} queued issue(s) were not started.`);
  } else if (usageHit) {
    console.log(`\nSTOPPED EARLY: ${usageHit}; ${issues.length - results.length} queued issue(s) were not started.`);
  }
  for (const w of waiting) console.log(`waiting, not started: #${w.issue} - on ${w.on.map((d) => `#${d}`).join(", ")}`);
  for (const k of keptWorktrees) {
    console.log(`worktree kept with uncommitted files: #${k.issue} - ${k.path} (inspect, then \`git worktree remove --force\` it)`);
  }
  console.log("Branches left standing for review are not deleted. Nothing is pushed.");
  view.close(
    `merged ${merged.length}` +
      (conflicted.length + failedToLand.length + skipped.length ? `, not landed ${conflicted.length + failedToLand.length + skipped.length}` : "") +
      (heldBack.length ? `, needs a human ${heldBack.length}` : "") +
      ` of ${issues.length}`,
  );
};
