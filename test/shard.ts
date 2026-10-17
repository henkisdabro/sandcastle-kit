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
  "test/quiet-output.test.ts": 41,
  "test/base-gates-recorded.test.ts": 39,
  "test/status-lifecycle.test.ts": 36,
  "test/newest-release.test.ts": 31,
  "test/gap-in-prose-false.test.ts": 27,
  "test/carried-late-comment.test.ts": 24,
  "test/status-settings.test.ts": 22,
  "test/cpu-pressure.test.ts": 20,
  "test/fix-wait.test.ts": 19,
  "test/pipeline-red-third-run.test.ts": 19,
  "test/guard-worktree-records.test.ts": 17,
  "test/requeue-red-subject.test.ts": 17,
  "test/detach.test.ts": 16,
  "test/sandbox-image-lock.test.ts": 16,
  "test/landing-requeue.test.ts": 15,
  "test/pipeline.test.ts": 15,
  "test/status-collectors.test.ts": 15,
  "test/status-facts.test.ts": 15,
  "test/api-key-spend.test.ts": 14,
  "test/landing-queue.test.ts": 14,
  "test/landing-wait-recorded.test.ts": 14,
  "test/doctor-mod.test.ts": 13,
  "test/doctor-prereqs.test.ts": 13,
  "test/landing-red-rerun.test.ts": 13,
  "test/pipeline-base-merge-before-gates.test.ts": 13,
  "test/pipeline-red-rerun.test.ts": 13,
  "test/base-verify-slot-wait.test.ts": 12,
  "test/carried-rewritten-base.test.ts": 12,
  "test/docker-hang.test.ts": 12,
  "test/doctor-size-pointer.test.ts": 12,
  "test/hook-checks-kept-across-landings.test.ts": 12,
  "test/landing-check-large.test.ts": 12,
  "test/pause-resume.test.ts": 12,
  "test/sandbox-cpus-commands.test.ts": 12,
  "test/cap-command.test.ts": 11,
  "test/doctor-newest-release.test.ts": 11,
  "test/gap-in-prose-fixed.test.ts": 11,
  "test/status-links.test.ts": 11,
  "test/status-render.test.ts": 11,
  "test/usage-guard-settings.test.ts": 11,
  "test/herdr-view-reuse.test.ts": 10,
  "test/land-command.test.ts": 10,
  "test/release-dependants.test.ts": 10,
  "test/stale-git-lock.test.ts": 10,
  "test/gap-in-prose.test.ts": 9,
  "test/guard-before-open.test.ts": 9,
  "test/agents-image.test.ts": 8,
  "test/backup-branches.test.ts": 8,
  "test/carried.test.ts": 8,
  "test/preflight-parallel.test.ts": 8,
  "test/run-settings-cross-review.test.ts": 8,
  "test/sandbox-layer-lock.test.ts": 8,
  "test/status-hand-merged-partly.test.ts": 8,
  "test/doctor-keep-warm.test.ts": 7,
  "test/hand-merged-pushed.test.ts": 7,
  "test/herdr-click-hint.test.ts": 7,
  "test/landing-rerun-tests.test.ts": 7,
  "test/pipeline-conflict-before-landing.test.ts": 7,
  "test/pipeline-load-red.test.ts": 7,
  "test/pool-wait-order.test.ts": 7,
  "test/runtime-probe.test.ts": 7,
  "test/usage-pause.test.ts": 7,
  "test/base-red-check.test.ts": 6,
  "test/base-red-mid-run.test.ts": 6,
  "test/doctor-idle-mark.test.ts": 6,
  "test/doctor-linux-runtime.test.ts": 6,
  "test/gap-in-prose-bold.test.ts": 6,
  "test/herdr-restart.test.ts": 6,
  "test/landing-claim-sandbox-wait.test.ts": 6,
  "test/landing-requeue-red.test.ts": 6,
  "test/landing-slot-first.test.ts": 6,
  "test/pipeline-named-strays.test.ts": 6,
  "test/requeue-red-wording.test.ts": 6,
  "test/stale-empty-branch.test.ts": 6,
  "test/status-seams.test.ts": 6,
  "test/structured-report.test.ts": 6,
  "test/version-json.test.ts": 6,
  "test/backup-prune.test.ts": 5,
  "test/carried-fork-point.test.ts": 5,
  "test/doctor-env-committed.test.ts": 5,
  "test/doctor-repo-access.test.ts": 5,
  "test/gates-log-sections.test.ts": 5,
  "test/hand-merged.test.ts": 5,
  "test/herdr-dead-tab-claim.test.ts": 5,
  "test/hook-check-vouched.test.ts": 5,
  "test/land-unmet.test.ts": 5,
  "test/landing-deletes-branch.test.ts": 5,
  "test/landing.test.ts": 5,
  "test/preview.test.ts": 5,
  "test/sandbox-image-prune.test.ts": 5,
  "test/stale-empty-branch-kept-worktree.test.ts": 5,
  "test/usage-command.test.ts": 5,
  "test/verify-skip-gate-only-proof.test.ts": 5,
  "test/cli-spawn.test.ts": 4,
  "test/detach-gap.test.ts": 4,
  "test/doctor-live-runs.test.ts": 4,
  "test/doctor-other-checkout.test.ts": 4,
  "test/doctor-path-checkout.test.ts": 4,
  "test/followup-stop.test.ts": 4,
  "test/gap-in-prose-lead-in.test.ts": 4,
  "test/gh-errors.test.ts": 4,
  "test/guard-config-keys.test.ts": 4,
  "test/hooks-path-outside.test.ts": 4,
  "test/land-only-ungated.test.ts": 4,
  "test/landing-cache-isolated.test.ts": 4,
  "test/landing-claim-gates.test.ts": 4,
  "test/landing-filter-before-ff.test.ts": 4,
  "test/notify.test.ts": 4,
  "test/overlap.test.ts": 4,
  "test/pipeline-repair-verdict.test.ts": 4,
  "test/run-settings-repair-concurrency.test.ts": 4,
  "test/schedule-resolve-settle.test.ts": 4,
  "test/size.test.ts": 4,
  "test/status-usage.test.ts": 4,
  "test/temp-cleanup.test.ts": 4,
  "test/tracker-read-limit.test.ts": 4,
  "test/unmet.test.ts": 4,
  "test/weights-reporter.test.ts": 4,
  "test/worktree-limit-inject.test.ts": 4,
  "test/backup-size.test.ts": 3,
  "test/command-help.test.ts": 3,
  "test/doctor-local-config.test.ts": 3,
  "test/doctor-ps.test.ts": 3,
  "test/followup-run-tickets.test.ts": 3,
  "test/gap-in-prose-clauses.test.ts": 3,
  "test/git-guard-scratch-repo.test.ts": 3,
  "test/guard-start-own-changes.test.ts": 3,
  "test/heartbeat-landing-slot-wait.test.ts": 3,
  "test/herdr-view-quit.test.ts": 3,
  "test/land-squash.test.ts": 3,
  "test/landing-facts.test.ts": 3,
  "test/landing-failed-before-fixed.test.ts": 3,
  "test/landing-hardening.test.ts": 3,
  "test/landing-precheck.test.ts": 3,
  "test/lean-preview-keeps-run-plan.test.ts": 3,
  "test/live-runs.test.ts": 3,
  "test/merge-comment-review-commits.test.ts": 3,
  "test/merge-driver.test.ts": 3,
  "test/partial-clone-merge-check.test.ts": 3,
  "test/raw-log.test.ts": 3,
  "test/report-changelog-land.test.ts": 3,
  "test/report-drain-carry.test.ts": 3,
  "test/resolution-base-side.test.ts": 3,
  "test/schedule-gate-wait-worker.test.ts": 3,
  "test/settings.test.ts": 3,
  "test/status-landing-wait.test.ts": 3,
  "test/status-live-look.test.ts": 3,
  "test/status-wrapper.test.ts": 3,
  "test/touches-overrun.test.ts": 3,
  "test/verify-after-one-merge.test.ts": 3,
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
