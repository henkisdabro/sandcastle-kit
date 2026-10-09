// Two prompt rules agents ignored were dropped, as the Edit-tool rule was: in one 32-ticket run 14
// of 33 implement passes wrote a commit message with a heredoc, and about 12 chained gates in one
// command, with no refusal either way. The prompts keep `git commit -F <file>` and each gate's output
// in a file. No model calls.
//
//   pnpm test:file test/prompt-dropped-habit-rules.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8").replace(/\s+/g, " ");

test("no prompt forbids a shell heredoc for the commit message, and each keeps `git commit -F <file>`", () => {
  for (const name of ["implement.md", "review.md", "repair.md"]) {
    const p = read("prompts", name);
    assert.doesNotMatch(p, /never a shell heredoc/, name);
    assert.match(p, /then `git commit -F <file>`: never `git commit -m "\.\.\."`\./, name);
  }
});

test("the implementer is not told to run gates one per command, and still sends each gate's output to a file", () => {
  const p = read("prompts", "implement.md");
  assert.doesNotMatch(p, /never several in one command|in its own command/);
  assert.match(p, /Redirect each gate to a file outside the worktree/);
  assert.match(p, /Before you finish, run each gate once\./);
});
