// Prints the test files of one CI shard (`TEST_SHARD=2/4`), one per line, packed by weight so
// every shard takes about as long. node's own --test-shard deals the files out in turn: that put
// the four slowest in one shard of four, which ran twice as long as the rest and set the run's time.
//
//   TEST_SHARD=2/4 node test/shard.ts
//
// A file missing from WEIGHTS counts as one second, so a new file is still run, and stale weights
// only cost balance, never coverage.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Seconds per file as CI's shards ran it, beside its neighbours (test/weights-reporter.ts, every
// run's `weights-*` artifacts): each file's mean on ubuntu-24.04-arm and on macos-latest, over the
// runs read. Every file not listed averaged under 2.5. Written by test/weights.ts: to refresh it
// from a green run, `gh run download RUN_ID --pattern 'weights-*' --dir DIR`, then
// `node test/weights.ts --write DIR` (its header says more).
const WEIGHTS: Record<string, number> = {
  "test/quiet-output.test.ts": 43,
  "test/status-seams.test.ts": 39,
  "test/status-lifecycle.test.ts": 33,
  "test/status-facts.test.ts": 32,
  "test/newest-release.test.ts": 31,
  "test/base-gates-recorded.test.ts": 28,
  "test/cpu-pressure.test.ts": 20,
  "test/landing-requeue.test.ts": 19,
  "test/status-settings.test.ts": 19,
  "test/gap-in-prose-false.test.ts": 18,
  "test/landing-queue.test.ts": 18,
  "test/carried-late-comment.test.ts": 17,
  "test/sandbox-image-lock.test.ts": 15,
  "test/detach.test.ts": 14,
  "test/doctor-prereqs.test.ts": 14,
  "test/doctor-size-pointer.test.ts": 13,
  "test/fix-wait.test.ts": 13,
  "test/landing-wait-recorded.test.ts": 13,
  "test/requeue-red-subject.test.ts": 13,
  "test/base-verify-slot-wait.test.ts": 12,
  "test/docker-hang.test.ts": 12,
  "test/guard-worktree-records.test.ts": 12,
  "test/pause-resume.test.ts": 12,
  "test/pipeline.test.ts": 12,
  "test/release-dependants.test.ts": 12,
  "test/status-collectors.test.ts": 12,
  "test/doctor-mod.test.ts": 11,
  "test/doctor-newest-release.test.ts": 11,
  "test/landing-check-large.test.ts": 11,
  "test/api-key-spend.test.ts": 10,
  "test/pipeline-load-red.test.ts": 10,
  "test/pipeline-red-rerun.test.ts": 10,
  "test/herdr-view-reuse.test.ts": 9,
  "test/hook-checks-kept-across-landings.test.ts": 9,
  "test/land-command.test.ts": 9,
  "test/pipeline-red-third-run.test.ts": 9,
  "test/pool-wait-order.test.ts": 9,
  "test/sandbox-layer-lock.test.ts": 9,
  "test/status-links.test.ts": 9,
  "test/status-render.test.ts": 9,
  "test/cap-command.test.ts": 8,
  "test/preflight-parallel.test.ts": 8,
  "test/sandbox-cpus-commands.test.ts": 8,
  "test/stale-git-lock.test.ts": 8,
  "test/usage-guard-settings.test.ts": 8,
  "test/doctor-idle-mark.test.ts": 7,
  "test/doctor-keep-warm.test.ts": 7,
  "test/gap-in-prose-fixed.test.ts": 7,
  "test/gap-in-prose.test.ts": 7,
  "test/landing-red-rerun.test.ts": 7,
  "test/pipeline-base-merge-before-gates.test.ts": 7,
  "test/runtime-probe.test.ts": 7,
  "test/stale-empty-branch.test.ts": 7,
  "test/carried-rewritten-base.test.ts": 6,
  "test/carried.test.ts": 6,
  "test/gap-in-prose-bold.test.ts": 6,
  "test/hand-merged-pushed.test.ts": 6,
  "test/herdr-click-hint.test.ts": 6,
  "test/landing-claim-sandbox-wait.test.ts": 6,
  "test/landing-slot-first.test.ts": 6,
  "test/pipeline-conflict-before-landing.test.ts": 6,
  "test/run-settings-cross-review.test.ts": 6,
  "test/sandbox-image-prune.test.ts": 6,
  "test/stale-empty-branch-kept-worktree.test.ts": 6,
  "test/status-hand-merged-partly.test.ts": 6,
  "test/structured-report.test.ts": 6,
  "test/usage-pause.test.ts": 6,
  "test/version-json.test.ts": 6,
  "test/agents-image.test.ts": 5,
  "test/backup-branches.test.ts": 5,
  "test/detach-gap.test.ts": 5,
  "test/doctor-other-checkout.test.ts": 5,
  "test/gates-log-sections.test.ts": 5,
  "test/guard-before-open.test.ts": 5,
  "test/hook-check-vouched.test.ts": 5,
  "test/landing-cache-isolated.test.ts": 5,
  "test/landing-requeue-red.test.ts": 5,
  "test/landing-rerun-tests.test.ts": 5,
  "test/run-settings-repair-concurrency.test.ts": 5,
  "test/status-wrapper.test.ts": 5,
  "test/base-red-check.test.ts": 4,
  "test/base-red-mid-run.test.ts": 4,
  "test/cli-spawn.test.ts": 4,
  "test/command-help.test.ts": 4,
  "test/doctor-env-committed.test.ts": 4,
  "test/doctor-linux-runtime.test.ts": 4,
  "test/doctor-live-runs.test.ts": 4,
  "test/doctor-local-config.test.ts": 4,
  "test/doctor-repo-access.test.ts": 4,
  "test/gh-errors.test.ts": 4,
  "test/guard-config-keys.test.ts": 4,
  "test/hand-merged.test.ts": 4,
  "test/herdr-dead-tab-claim.test.ts": 4,
  "test/herdr-restart.test.ts": 4,
  "test/herdr-view-quit.test.ts": 4,
  "test/hooks-path-outside.test.ts": 4,
  "test/landing-deletes-branch.test.ts": 4,
  "test/landing-filter-before-ff.test.ts": 4,
  "test/landing.test.ts": 4,
  "test/overlap.test.ts": 4,
  "test/pipeline-named-strays.test.ts": 4,
  "test/requeue-red-wording.test.ts": 4,
  "test/schedule-resolve-settle.test.ts": 4,
  "test/status-live-look.test.ts": 4,
  "test/temp-cleanup.test.ts": 4,
  "test/tracker-read-limit.test.ts": 4,
  "test/usage-command.test.ts": 4,
  "test/verify-skip-gate-only-proof.test.ts": 4,
  "test/weights-reporter.test.ts": 4,
  "test/worktree-limit-inject.test.ts": 4,
  "test/backup-prune.test.ts": 3,
  "test/backup-size.test.ts": 3,
  "test/carried-fork-point.test.ts": 3,
  "test/clean-checks.test.ts": 3,
  "test/doctor-path-checkout.test.ts": 3,
  "test/doctor-ps.test.ts": 3,
  "test/followup-stop.test.ts": 3,
  "test/gap-in-prose-clauses.test.ts": 3,
  "test/gap-in-prose-lead-in.test.ts": 3,
  "test/git-guard-scratch-repo.test.ts": 3,
  "test/guard-start-own-changes.test.ts": 3,
  "test/heartbeat-landing-slot-wait.test.ts": 3,
  "test/land-unmet.test.ts": 3,
  "test/landing-claim-gates.test.ts": 3,
  "test/landing-hardening.test.ts": 3,
  "test/landing-precheck.test.ts": 3,
  "test/lean-preview-keeps-run-plan.test.ts": 3,
  "test/merge-driver.test.ts": 3,
  "test/notify.test.ts": 3,
  "test/partial-clone-merge-check.test.ts": 3,
  "test/pipeline-repair-verdict.test.ts": 3,
  "test/preview.test.ts": 3,
  "test/queue-lint-named.test.ts": 3,
  "test/run-live-contract.test.ts": 3,
  "test/schedule-gate-wait-worker.test.ts": 3,
  "test/size.test.ts": 3,
  "test/verify-skip-green-base.test.ts": 3,
};

const [index, total] = (process.env.TEST_SHARD ?? "").split("/").map(Number);
if (!(Number.isInteger(index) && Number.isInteger(total) && index >= 1 && index <= total)) {
  throw new Error(`TEST_SHARD must be i/n with 1 <= i <= n, not ${JSON.stringify(process.env.TEST_SHARD)}`);
}

const weight = (file: string) => WEIGHTS[file] ?? 1;
const files = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `test/${f}`)
  .sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));

// Heaviest first, each into the lightest shard so far: within a file's weight of even.
const shards = Array.from({ length: total }, () => ({ load: 0, files: [] as string[] }));
for (const file of files) {
  const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
  lightest.files.push(file);
  lightest.load += weight(file);
}
console.log(shards[index - 1]!.files.join("\n"));
