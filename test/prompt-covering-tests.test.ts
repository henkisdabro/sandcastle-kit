// Implementers missed the tests that cover their change (a test file outside the obvious ones that
// imports the changed module; repo-wide ratchet tests that count every script) and followed a
// project's "run the full suite before you commit" rule inside a sandbox, where the orchestrator's
// gates do that. The implement prompt now says how to find the covering tests, whose job the full
// suite is, and that a person's step is an `<unmet who="person">` line even when the ticket says so.
// No model calls.
//
//   pnpm test:file test/prompt-covering-tests.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const prompt = readFileSync(join(import.meta.dirname, "..", "prompts", "implement.md"), "utf8").replace(/\s+/g, " ");

test("the implementer is told how to find the covering tests: git grep -l the changed names, run every file listed", () => {
  assert.match(prompt, /`git grep -l` the names of the changed modules and functions over the test directories/);
  assert.match(prompt, /run every file it lists/);
  assert.match(prompt, /Where the project rules name a command for this, use it/);
});

test("the implementer is told a repo-wide test covers a new file too", () => {
  assert.match(prompt, /A test that scans the whole repo \(a ratchet, a count baseline, a lint-like check over every file\) covers a new file too/);
});

test("a project's run-the-full-suite instruction is the gates' job inside a sandbox", () => {
  assert.match(
    prompt,
    /A project instruction to run the full suite or every gate before committing is met here by the orchestrator's gates: run only the tests that cover your change/,
  );
});

test("a step left for a person is an unmet who=person line even when the ticket says so", () => {
  assert.match(prompt, /A step only a person can do is an `<unmet who="person">` line even when the ticket already says so/);
});

test("the prompt stays generic: no project script names", () => {
  assert.doesNotMatch(prompt, /test:related/);
  assert.doesNotMatch(prompt, /pnpm/);
});
