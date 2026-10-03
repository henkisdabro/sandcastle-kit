// A requeued ticket that lands on its second attempt keeps its first attempt's review commits in
// `reviewCommits`, as `commits` keeps them in the branch total. No Docker, model or network.
//
//   pnpm exec tsx --test test/review-commits-requeued.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { firstAttemptReviewCommits } = await import("../src/landing.ts");

const done = (issue: string, reviewCommits: number): PromiseSettledResult<{ issue: string; reviewCommits: number }> => ({
  status: "fulfilled",
  value: { issue, reviewCommits },
});

test("the first attempt's review commits are found among this run's results", () => {
  // The reviewer's fix on attempt one; attempt two's resolution review then adds its own.
  assert.equal(firstAttemptReviewCommits([done("1", 0), done("193", 1)], "193"), 1);
});

test("no first attempt in this run (a branch from an earlier run) counts 0", () => {
  assert.equal(firstAttemptReviewCommits([done("1", 2)], "193"), 0);
  assert.equal(firstAttemptReviewCommits([{ status: "rejected", reason: new Error("x") }], "193"), 0);
  assert.equal(firstAttemptReviewCommits([], "193"), 0);
});

test("the land-only re-run starts from the first attempt's count and adds the resolution review's", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "burndown.ts"), "utf8");
  assert.match(src, /let reviewCommits = landOnly && requeued \? firstAttemptReviewCommits\(results, issue\.id\) : 0;/);
  assert.match(src, /reviewCommits \+= resolved\.commits\.length;/);
});
