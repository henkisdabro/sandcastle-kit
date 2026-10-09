// Lessons from agent sessions, held in the files the agents read. A reviewer committed a deadlock fix
// with only an `<ungated>` line; implementers made a waiting ticket keep its sandbox slot while it
// waited on something that needed another; and a mutation check chained its restore after a test
// that hung, went to the background with it, and a `pkill -f` on the test's path killed the agent's
// own shell, leaving the worktree reverted. No model calls.
//
//   pnpm test:file test/prompt-mutation-check.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8").replace(/\s+/g, " ");

test("every agent that may run a test without its change limits the run, restores apart, and never self-matches", () => {
  for (const name of ["implement.md", "review.md", "repair.md"]) {
    const p = read("prompts", name);
    assert.match(
      p,
      name === "review.md"
        ? /git diff \{\{TARGET_BRANCH\}\}\.\.\.HEAD -- <files> > \/tmp\/p && git apply -R \/tmp\/p`, run it, then `git apply \/tmp\/p`/
        : /git diff HEAD -- <files> > \/tmp\/p && git checkout HEAD -- <files>`, run it, then `git apply \/tmp\/p`/,
      name,
    );
    assert.match(p, /Give that test run a time limit/, name);
    assert.match(p, /Run `git apply \/tmp\/p` as a command of its own, never chained after the test/, name);
    assert.match(p, /Never `pgrep -f` or `pkill -f` a pattern that also appears in your own command line/, name);
  }
});

test("a fix the reviewer commits is proved by a test, not by an ungated line", () => {
  const p = read("prompts", "review.md");
  assert.match(p, /A fix you commit is proved by a test, the same rule as the implementer's\./);
  assert.match(p, /An `<ungated>` line is not that proof/);
});

test("the pool section forbids waiting, with a slot held, on anything that needs another slot", () => {
  const a = read("docs", "architecture.md");
  const pool = a.slice(a.indexOf("## `src/pool.ts`"), a.indexOf("## `src/usage.ts`"));
  assert.match(pool, /Code that waits while holding a pool slot must not wait on anything that needs another slot/);
});

// A single-file run with no limit hung a pass for its tool's whole 15 minutes, and a python heredoc
// ended at an `EOF` line of the file it edited and ran the rest of the script as shell.
test("every agent that runs tests by hand limits each run and picks a heredoc delimiter the file lacks", () => {
  for (const name of ["implement.md", "review.md", "repair.md"]) {
    const p = read("prompts", name);
    assert.match(p, /Every other test you run by hand \(one file, one case\) gets a limit too, `timeout 300 <command>`/, name);
    assert.match(p, /\(`<<'PYEOF'`, not `<<'EOF'`\)/, name);
  }
});
