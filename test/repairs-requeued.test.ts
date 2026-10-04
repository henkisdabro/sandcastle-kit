// A ticket repaired once, requeued and repaired again reports every repair in its outcome line: the
// repair counter is per attempt, so the second attempt starts from the first's. No Docker, model or network.
//
//   pnpm exec tsx --test test/repairs-requeued.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { firstAttemptRepairs } = await import("../src/landing.ts");

const done = (issue: string, repairs: number): PromiseSettledResult<{ issue: string; repairs: number }> => ({
  status: "fulfilled",
  value: { issue, repairs },
});

test("the first attempt's repairs are found among this run's results", () => {
  assert.equal(firstAttemptRepairs([done("1", 0), done("193", 1)], "193"), 1);
});

test("no first attempt in this run counts 0", () => {
  assert.equal(firstAttemptRepairs([done("1", 2)], "193"), 0);
  assert.equal(firstAttemptRepairs([{ status: "rejected", reason: new Error("x") }], "193"), 0);
  assert.equal(firstAttemptRepairs([], "193"), 0);
});

test("one repair per attempt reports repaired=2: the second attempt adds its own to the first's", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "burndown.ts"), "utf8");
  assert.match(src, /const earlierRepairs = requeued \? firstAttemptRepairs\(results, issue\.id\) : 0;/);
  assert.match(src, /repairs: earlierRepairs \+ repairs,/);
  // The first attempt's one repair plus the second's one.
  assert.equal(firstAttemptRepairs([done("193", 1)], "193") + 1, 2);
});
