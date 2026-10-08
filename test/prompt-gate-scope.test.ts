// Agents ran the project's full suite right before the orchestrator gated the same commit: in a 22-ticket
// run, 40 full-suite runs took about two thirds of the agent minutes, a conflict resolver spent nearly
// all its time on one, and a reviewer re-ran the suite after a docs-only commit. The prompts now say who
// runs what, and the implementer says which spec it followed when a comment amended the ticket's.
// No model calls.
//
//   pnpm test:file test/prompt-gate-scope.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "prompts", name), "utf8").replace(/\s+/g, " ");

test("the resolver runs the typecheck gate and the tests covering the conflicted files, not the full suite", () => {
  const p = read("resolve.md");
  assert.doesNotMatch(p, /Run all of these/);
  assert.match(p, /do not run the full suite yourself/);
  assert.match(p, /Run only the typecheck gate .* and the test files that cover the conflicted files/);
  assert.match(p, /The orchestrator gates the merge commit after you exit/);
});

test("the resolver's finishing and commit steps no longer ask for every gate", () => {
  const p = read("resolve.md");
  assert.doesNotMatch(p, /run the gates, `git add`/);
  assert.doesNotMatch(p, /the gates pass and the merge is committed/);
  assert.match(p, /typecheck gate and the covering tests pass and the merge is committed/);
});

test("the reviewer runs the full suite once, and only if its own commits changed code", () => {
  const p = read("review.md");
  assert.match(p, /Run the full suite once, and only if your own commits changed code; after docs-only commits .*, none\./);
});

test("the implementer names the spec it followed when a comment on the ticket amends it", () => {
  const p = read("implement.md");
  assert.match(p, /When a comment on the ticket amends its spec .* that record also says which spec you followed: the body's or the comment's\./);
});
