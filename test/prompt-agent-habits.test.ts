// The implementer is told to run the gates in the foreground with output in a file, and to look in
// the project rules for the test runner's output format. Dogfood agents grepped TAP lines out of
// node:test's spec output and polled a background suite with `sleep`. No model calls.
//
//   pnpm test:file test/prompt-agent-habits.test.ts

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

// An implementer timed the full check four times under load, then woke itself 17 times with Monitor
// to wait for it: half an hour on the run's critical path, and every other sandbox's gates slowed.
test("the implementer never times the gates, and leaves a requested timing to a person", () => {
  const p = read("prompts", "implement.md");
  assert.match(p, /never several in one command, and never to time or compare it/);
  assert.match(p, /leave it as an `<unmet>` line for a person/);
  assert.match(p, /do not wait on it with Monitor either/);
});

// A 2-minute default timeout moved the suite to the background in six of 29 passes, and a
// reviewer then waited ten minutes on a `pgrep -f` loop that matched itself.
test("every agent that runs the gates runs them in the foreground with the longest timeout", () => {
  for (const name of ["review.md", "repair.md", "resolve.md"]) {
    const p = read("prompts", name);
    assert.match(p, /Run each gate in the foreground with the tool's longest timeout/, name);
    assert.match(p, /never wait on a backgrounded run with `sleep`, `pgrep` or Monitor, and never run the suite to time it/, name);
  }
});

// The Edit-tool rule cost words in every prompt and was not followed: implementers kept editing with
// heredocs and `sed -i`, and the reviewer and the gates catch a bad replace. It stays out.
test("no prompt tells the agent which tool to edit files with", () => {
  for (const name of ["implement.md", "review.md", "repair.md", "resolve.md"]) {
    const p = read("prompts", name);
    assert.doesNotMatch(p, /Edit tool|goes through Edit/, name);
  }
});

test("this repository's rules name node:test's spec output", () => {
  const r = read(".sandcastle", "rules.md");
  assert.ok(r.includes("`ℹ pass N`") && r.includes("`✖`"));
  assert.match(r, /does not print TAP/);
});
