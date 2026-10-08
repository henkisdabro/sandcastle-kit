// The resolve prompt runs the test files that cover the conflicted files by hand, so it carries the
// safety sentences the implement, review and repair prompts share: no `git stash` in the shared
// `.git`, no `pgrep -f` or `pkill -f` on a pattern in the agent's own command line, a time limit on
// every test run by hand, and a heredoc delimiter the edited file cannot contain. Those prompts'
// tests list three prompts, so leaving resolve out failed nothing. No model calls.
//
//   pnpm test:file test/prompt-resolve-safety.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const resolve = readFileSync(join(import.meta.dirname, "..", "prompts", "resolve.md"), "utf8").replace(/\s+/g, " ");

test("the resolver is told never to stash in the shared .git", () => {
  assert.ok(resolve.includes("Never `git stash` in this worktree"));
});

test("the resolver is told not to pgrep -f or pkill -f a pattern in its own command line", () => {
  assert.ok(resolve.includes("Never `pgrep -f` or `pkill -f` a pattern that also appears in your own command line"));
});

test("the resolver is told to limit every test it runs by hand", () => {
  assert.ok(resolve.includes("timeout 300 <command>"));
});

test("the resolver is told to pick a heredoc delimiter the edited file lacks", () => {
  assert.ok(resolve.includes("(`<<'PYEOF'`, not `<<'EOF'`)"));
});
