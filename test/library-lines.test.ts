// The library prints two lines a kit run gets wrong: "Could not fetch from origin" on every resumed
// branch (agent branches are never pushed, so it read as a network fault), and, for a kept worktree,
// a `git worktree remove --force` that bypasses `sandcastle clean`. Both are reworded.
//
//   pnpm test:file test/library-lines.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { reword } from "../src/run.ts";

test("a resumed branch is not reported as a failed fetch", () => {
  assert.equal(
    reword("Could not fetch from origin (reusing worktree at /p/.sandcastle/worktrees/agent-issue-57 as-is, branch 'agent/issue-57')"),
    "Resuming branch 'agent/issue-57' in its kept worktree (/p/.sandcastle/worktrees/agent-issue-57)",
  );
});

test("a kept worktree points at sandcastle clean", () => {
  assert.equal(
    reword("  To clean up: git worktree remove --force /p/.sandcastle/worktrees/agent-issue-57"),
    "  To clean up: `sandcastle clean` - or leave it, and the next `sandcastle run` resumes it",
  );
});

test("any other line is left alone", () => {
  for (const line of ["[impl-57] Started on branch agent/issue-57", "  To review: cd /p", ""]) assert.equal(reword(line), line);
});
