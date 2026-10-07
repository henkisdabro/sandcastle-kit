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

// Seconds per file, startup included: the mean of a one-file-at-a-time run on ubuntu-24.04-arm and
// one on macos-latest. Every file not listed averaged under 2.5. To refresh, run `pnpm test:weights`
// (test/weights-reporter.ts) on each and paste the mean of the blocks it prints over this table.
const WEIGHTS: Record<string, number> = {
  // 30 alone, but its eight child test runs compete with the rest of its shard for the runner's
  // cores, and in a shard it took more than twice that.
  "test/quiet-output.test.ts": 50,
  "test/detach.test.ts": 16,
  "test/cap-command.test.ts": 11,
  "test/doctor-prereqs.test.ts": 10,
  "test/doctor-size-pointer.test.ts": 10,
  "test/pool-wait-order.test.ts": 10,
  "test/preflight-parallel.test.ts": 9,
  "test/doctor-mod.test.ts": 8,
  "test/landing-queue.test.ts": 8,
  "test/landing-requeue.test.ts": 8,
  "test/backup-branches.test.ts": 7,
  "test/lock.test.ts": 7,
  "test/doctor-idle-mark.test.ts": 6,
  "test/notify.test.ts": 6,
  "test/release-dependants.test.ts": 6,
  "test/command-help.test.ts": 5,
  "test/detach-gap.test.ts": 5,
  "test/gh-errors.test.ts": 5,
  "test/cli-spawn.test.ts": 4,
  "test/doctor-env-committed.test.ts": 4,
  "test/doctor-other-checkout.test.ts": 4,
  "test/land-command.test.ts": 4,
  "test/overlap.test.ts": 4,
  "test/size.test.ts": 4,
  "test/backup-size.test.ts": 3,
  "test/cli-first-contact.test.ts": 3,
  "test/cli.test.ts": 3,
  "test/doctor-path-checkout.test.ts": 3,
  "test/hand-merged.test.ts": 3,
  "test/landing.test.ts": 3,
  "test/live-runs.test.ts": 3,
  "test/machine-settings-keys.test.ts": 3,
  "test/preview.test.ts": 3,
  "test/settings.test.ts": 3,
  "test/signals.test.ts": 3,
  "test/status-settings.test.ts": 3,
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
