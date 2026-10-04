// The implementer is told to run the gates in the foreground with output in a file, to prefer the
// Edit tool to scripted replacements, and to look in the project rules for the test runner's output
// format. Dogfood agents grepped TAP lines out of node:test's spec output, polled a background suite
// with `sleep`, and replaced text with heredocs that no-op silently on a missed match. No model calls.
//
//   pnpm exec tsx --test test/prompt-agent-habits.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8").replace(/\s+/g, " ");

test("the implementer runs the gates in the foreground, output in a file, with a long enough timeout", () => {
  const p = read("prompts", "implement.md");
  assert.match(p, /Run the gates in the foreground, with their output in a file\./);
  assert.match(p, /the tool's longest timeout \(`timeout: 600000` in Claude Code/);
  assert.match(p, /Never start it in the background and wait on it with `sleep`/);
  assert.match(p, /how the test runner reports a pass and a failure/);
});

// A 2-minute default timeout moved the suite to the background in six of 29 passes, and a
// reviewer then waited ten minutes on a `pgrep -f` loop that matched itself.
test("every agent that runs the gates runs them in the foreground with the longest timeout", () => {
  for (const name of ["review.md", "repair.md", "resolve.md"]) {
    const p = read("prompts", name);
    assert.match(p, /Run each gate in the foreground with the tool's longest timeout/, name);
    assert.match(p, /never wait on a backgrounded run with `sleep` or `pgrep`/, name);
  }
});

test("the implementer prefers the Edit tool, or asserts each scripted replacement matched", () => {
  const p = read("prompts", "implement.md");
  assert.match(p, /Prefer the Edit tool to scripted replacements\./);
  assert.match(p, /assert that each replacement matched/);
});

test("this repository's rules name node:test's spec output", () => {
  const r = read(".sandcastle", "rules.md");
  assert.ok(r.includes("`ℹ pass N`") && r.includes("`✖`"));
  assert.match(r, /does not print TAP/);
});
