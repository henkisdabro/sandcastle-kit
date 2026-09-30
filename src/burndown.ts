// The issue-burndown orchestrator, for any project with a `.sandcastle/config.ts`.
//
//   Phase 1  Fan out - one sandbox per queued issue, own branch: implement,
//                      review (and optionally cross-review) on the same warm
//                      sandbox.
//   Phase 2  Gate    - the project's gates, run by the ORCHESTRATOR via
//                      exec(), never self-reported by an agent.
//   Phase 3  Land    - green branches merge to the base branch; the issue is
//                      closed with a comment. Red branches, and green ones
//                      that change hooks/CI/install scripts, are left standing.
//   Phase 4  Verify  - the gates once more on the merged base branch, because
//                      two branches green on their own can be red together.
//
// Environment: ISSUES=1,2 (instead of the queue label), CONCURRENCY, DRY_RUN=1,
// plus the model variables in agents.ts and the machine-wide limits in pool.ts.

import { createSandbox } from "@ai-hero/sandcastle";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS_LINE, crossReview, implAgent, reviewWithFallback } from "./agents.ts";
import type { Project } from "./config.ts";
import { assertGitUnchanged, disableHostGitHooks, gitFingerprint, lockRun, protectedChanges } from "./guard.ts";
import { checkHooks, plan as leanPlan, reportHookCheck } from "./lean.ts";
import { usage, withSlot } from "./pool.ts";
import { archiveFinishedLogs, assertCleanBase, openStatusPane, preflight, recordRun, renderPrompts } from "./run.ts";
import { ensureImage, sandboxConfig, sh } from "./sandbox.ts";
import { execGate, lockWorktree, releaseBranchWorktree, unlockWorktree } from "./worktree-lock.ts";

type Issue = { number: number; title: string };
type Gate = { name: string; pass: boolean };
type Outcome = {
  issue: number;
  branch: string;
  status: "shipped" | "gate-failed" | "nochange";
  commits: number;
  reviewCommits: number;
  gates: Gate[];
};

// What a spent plan allowance leaves at the end of an agent's log.
const LIMIT = /out of usage credits|usage limit|limit reached/i;

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
  const issues: Issue[] = process.env.ISSUES
    ? process.env.ISSUES.split(",").map((n) => {
        const i = JSON.parse(sh("gh", ["issue", "view", n.trim(), "--json", "number,title,state"]));
        if (i.state !== "OPEN") throw new Error(`#${i.number} is ${i.state.toLowerCase()}.`);
        return { number: i.number, title: i.title };
      })
    : JSON.parse(
        sh("gh", ["issue", "list", "--state", "open", "--label", project.label, "--limit", "100", "--json", "number,title"]),
      );
  if (issues.length === 0) {
    console.log(`No ${project.label} issues. Queue drained.`);
    return;
  }

  console.log(`${issues.length} issue(s), ${CONCURRENCY} at a time${DRY_RUN ? " [DRY RUN]" : ""} - ${MODELS_LINE}:`);
  for (const i of issues) console.log(`  #${i.number} ${i.title}`);
  console.log(`Machine-wide: ${usage()}`);

  const image = ensureImage(project);
  const prompts = renderPrompts(project);
  preflight(project, image);
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
  // A kept hook that cannot run fails on every tool call of every agent, or
  // silently guards nothing. Stop before any sandbox starts.
  const hookCheck = checkHooks(project, image, lean);
  reportHookCheck(hookCheck, lean.hooks.length);
  if (hookCheck.failures.length) throw new Error("A kept hook cannot run in the image - no sandbox started.");
  recordRun(project, { issues: issues.map((i) => i.number), dryRun: DRY_RUN });
  openStatusPane(project);
  const fingerprint = gitFingerprint(project);
  // Set when the shared .git changed under us; no further issue starts.
  let tampered: string | undefined;

  const runGates = (sandbox: Parameters<typeof execGate>[0], label: string) =>
    withSlot("gates", label, async () => {
      const gates: Gate[] = [];
      for (const g of project.gates) {
        const r = await execGate(sandbox, g.command);
        gates.push({ name: g.name, pass: r.exitCode === 0 });
        if (r.exitCode !== 0) break;
      }
      return gates;
    });

  // -------------------------------------------------------------------------
  // Phase 1 + 2: implement, review, gate - one pipeline per issue
  // -------------------------------------------------------------------------

  const pipeline = async (issue: Issue): Promise<Outcome> => {
    const branch = `agent/issue-${issue.number}`;
    const promptArgs = { ISSUE_NUMBER: String(issue.number) };

    releaseBranchWorktree(branch);
    const sandbox = await createSandbox({ branch, baseBranch: base, ...sandboxConfig(project, image, planFile) });

    try {
      // Normally already locked by the worktree hook; this covers a worktree
      // Sandcastle reused.
      lockWorktree(sandbox.worktreePath);
      const impl = await sandbox.run({
        name: `impl-${issue.number}`,
        agent: implAgent(),
        promptFile: prompts.implement,
        promptArgs,
        maxIterations: project.implement.maxIterations ?? 8,
        idleTimeoutSeconds: project.implement.idleTimeoutSeconds ?? 2400,
      });

      // `impl.commits` counts what THIS run added, which is zero in two very
      // different cases: the agent found nothing to do, and the agent found the
      // work already done on the branch from an earlier run. Only the first is
      // `nochange`. How far the branch is ahead of the base tells them apart -
      // without it, a branch whose review died could never be reviewed by
      // re-running the issue: it came straight back as `nochange` with the work
      // still standing, unreviewed and unmerged.
      const branchCommits = Number(sh("git", ["rev-list", "--count", `${base}..${branch}`]));
      if (impl.commits.length === 0 && branchCommits === 0) {
        return { issue: issue.number, branch, status: "nochange", commits: 0, reviewCommits: 0, gates: [] };
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
      const review = await reviewWithFallback(`#${issue.number}`, reviewRun(`review-${issue.number}`));
      const cross = await crossReview(`#${issue.number}`, reviewRun(`review-codex-${issue.number}`));
      const reviewCommits = review.commits.length + (cross?.commits.length ?? 0);

      // Gates are checked here, in the orchestrator. No agent gets to tell us
      // they passed - `exitCode` is returned rather than thrown.
      const gates = await runGates(sandbox, `#${issue.number} gates`);

      return {
        issue: issue.number,
        branch,
        status: gates.every((g) => g.pass) ? "shipped" : "gate-failed",
        // Branch total, so a re-run of an already-implemented branch does not
        // report 0 commits while shipping its work.
        commits: branchCommits + reviewCommits,
        reviewCommits,
        gates,
      };
    } finally {
      unlockWorktree(sandbox.worktreePath);
      await sandbox.close();
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
      for (let next = queue.shift(); next && limitHit === undefined && !tampered; next = queue.shift()) {
        const issue = next;
        results.push(
          await withSlot("sandboxes", `${project.name} #${issue.number}`, () => pipeline(issue)).then(
            (value) => ({ status: "fulfilled", value }) as const,
            (reason) => {
              if (hitLimit(issue.number)) limitHit = issue.number;
              return { status: "rejected", reason } as const;
            },
          ),
        );
      }
    }),
  );

  // -------------------------------------------------------------------------
  // Phase 3: land the green ones, sequentially, on the host
  // -------------------------------------------------------------------------

  assertGitUnchanged(project, fingerprint, "before landing");
  const green = results.flatMap((r) => (r.status === "fulfilled" && r.value.status === "shipped" ? [r.value] : []));
  const gateNames = project.gates.map((g) => g.name).join(", ");
  const merged: number[] = [];
  const conflicted: number[] = [];
  const heldBack: { issue: number; paths: string[] }[] = [];
  const failedToLand: { issue: number; reason: string }[] = [];

  for (const o of green) {
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
      sh("git", ["merge", "--no-ff", "--no-verify", "-m", `Merge ${o.branch} (closes #${o.issue})`, o.branch]);
      merged.push(o.issue);
      // A closed issue must leave the queue too, or it lingers as work that
      // is still waiting for an agent.
      sh("gh", ["issue", "edit", String(o.issue), "--remove-label", project.label]);
      sh("gh", [
        "issue", "close", String(o.issue), "--comment",
        `Shipped by the Sandcastle loop on \`${o.branch}\` (${o.commits} commit(s)); ${gateNames} all green before merge.`,
      ]);
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
        return await runGates(sandbox, `${project.name} verify gates`);
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
    console.log(`  #${o.issue} ${o.status.padEnd(11)} commits=${o.commits} (review=${o.reviewCommits}) ${g}  ${o.branch}`);
  }
  console.log(`\nmerged & closed: ${merged.join(", ") || "none"}`);
  if (conflicted.length) console.log(`merge conflicts: ${conflicted.join(", ")}`);
  for (const h of heldBack) console.log(`held for a human merge: #${h.issue} - changes ${h.paths.join(", ")}`);
  for (const f of failedToLand) console.log(`gated green but failed to land: #${f.issue} - ${f.reason}`);
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
  }
  console.log("Branches left standing for review are not deleted. Nothing is pushed.");
};
