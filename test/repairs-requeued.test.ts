// A ticket repaired once, requeued and repaired again reports every repair in its outcome line: the
// repair counter is per attempt, so the second attempt starts from the first's. No Docker, model or network. The pipeline itself,
// repaired on both attempts, is driven in test/pipeline.test.ts.
//
//   pnpm test:file test/repairs-requeued.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
