// test/shard-count.sh, the shards one suite pass gets in test/full-check.sh: the cores shared out
// between the passes running at once, so a plain full-check on a loaded machine does not
// oversubscribe it (five macOS tests timed out when two passes of 6 shards and the Linux
// container's ran at once on 15 cores). No Docker.
//
//   pnpm test:file test/shard-count.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

const count = (...args: string[]) => {
  const r = spawnSync("bash", [join(KIT, "test/shard-count.sh"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
};

test("a shard gets about two cores, shared between the passes running at once", () => {
  assert.equal(count("15", "3"), 3);
  assert.equal(count("15", "2"), 4);
  assert.equal(count("10", "3"), 2);
  assert.equal(count("12", "1"), 6);
});

test("the passes at once never ask for more than the cores allow", () => {
  for (const cores of [1, 2, 3, 4, 6, 8, 10, 12, 15, 16, 24, 64]) {
    for (const passes of [1, 2, 3]) {
      const n = count(String(cores), String(passes));
      assert.ok(n >= 1 && n <= 6, `${cores} cores, ${passes} passes: ${n}`);
      // Never more than one shard per core in all, and half the cores once there is room to.
      assert.ok(n * passes <= Math.max(cores, passes), `${cores} cores, ${passes} passes: ${n} shards each`);
      if (cores >= 4 * passes) assert.ok(n * passes * 2 <= cores + 2 * passes, `${cores} cores, ${passes} passes: ${n}`);
    }
  }
});

test("a small machine still runs one shard, and a big one stops at six", () => {
  assert.equal(count("1", "3"), 1);
  assert.equal(count("2", "1"), 1);
  assert.equal(count("128", "1"), 6);
});

test("without arguments it counts this machine's cores for one pass", () => {
  const n = count();
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 6);
});
