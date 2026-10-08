// The git guard matches the whole command string (test/git-guard-quoted-text.test.ts), so an edit
// whose text names a refused git command, made through a heredoc, is refused: one in 105 heredoc
// edits of a dogfood run. The maintainer kept that rule and decided the cheap fix: the implement and
// repair prompts tell the agent to carry such text through a file tool, never a command line. No
// model calls.
//
//   node --test test/prompt-guard-quoted-text.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8").replace(/\s+/g, " ");

for (const name of ["implement.md", "repair.md"]) {
  test(`${name} sends text that names a refused git command through a file, not a command line`, () => {
    const p = read("prompts", name);
    assert.match(p, /Text that names a git command the guard refuses/);
    assert.match(p, /in a heredoc, a script or a commit message - goes through the Edit or Write tool or a file, never on a shell command line/);
  });

  test(`${name} keeps the line next to the heredoc delimiter advice`, () => {
    const p = read("prompts", name);
    assert.match(p, /runs the rest as shell\. Text that names a git command the guard refuses/);
  });
}

test("the guard itself still matches the whole command string (the decision keeps the rule)", () => {
  const g = readFileSync(join(import.meta.dirname, "..", "container", "git-guard.sh"), "utf8");
  assert.match(g, /so a heredoc, commit message or comment body that only quotes\s+# a refused command is refused too/);
});
