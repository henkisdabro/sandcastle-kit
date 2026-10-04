// The implementer tests at the ticket's seams and the reviewer checks the tests, after
// Matt Pocock's /tdd. Agents' tests already fail without their fix; what these rules aim at is a
// test that recomputes its expected value, mocks the repo's own code, or reruns the whole suite
// on every step. No model calls.
//
//   pnpm exec tsx --test test/prompt-test-first.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8").replace(/\s+/g, " ");

test("the implementer tests at the seam, reproduces a bug first, and commits each green step", () => {
  const p = read("prompts", "implement.md");
  assert.match(p, /Use the ticket's `## Seams` section if it has one/);
  assert.match(p, /For a bug, first write a test that fails on the bug itself/);
  assert.match(p, /A value recomputed the way the code computes it passes by construction/);
  assert.match(p, /Mock only real boundaries/);
  assert.match(p, /run single test files and the typecheck, and commit each step that is green/);
  assert.match(p, /Before you finish, run each gate once, in its own command/);
});

test("the reviewer asks whether each test would fail if the behaviour broke", () => {
  const p = read("prompts", "review.md");
  assert.match(p, /would it fail if the behaviour broke, and survive a refactor that kept the behaviour\?/);
  assert.match(p, /break the behaviour, confirm the test fails, then restore the code/);
  assert.match(p, /Do not reorganise sound code to your taste/);
});

test("queue and audit write a Seams section only where the test boundary is not obvious", () => {
  assert.match(read("skill", "queue.md"), /\*\*Seams\.\*\* For a behaviour change whose test boundary is not obvious/);
  assert.match(read("skill", "audit.md"), /evidence and seams rules/);
});
