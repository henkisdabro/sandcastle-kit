// A sandbox agent that backgrounds a long command of its own (a download, an install, a build) has
// no Monitor (the managed settings deny it) and Claude Code blocks a leading `sleep`. Each prompt
// tells it to run such a command in the foreground and, failing that, to wait with one bounded
// foreground command. The gate rules stay as they are. No model calls.
//
//   pnpm test:file test/prompt-background-wait.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8").replace(/\s+/g, " ");

test("every agent prompt says how to run and wait for a long command that is not a gate", () => {
  for (const name of ["implement.md", "review.md", "repair.md", "resolve.md"]) {
    const p = read("prompts", name);
    assert.ok(
      p.includes(
        "A long command that is not a gate - a download, an install, a build - also runs in the foreground with the tool's longest timeout, never in the background.",
      ),
      name,
    );
    assert.ok(p.includes("`timeout 600 bash -c 'until <check>; do sleep 5; done'`"), name);
    assert.ok(p.includes("never `pgrep -f`. A bare `sleep` is blocked and Monitor is not available here."), name);
  }
});

test("the implementer is told Claude Code blocks sleep, not the sandbox", () => {
  const p = read("prompts", "implement.md");
  assert.match(p, /`sleep`, which Claude Code blocks,/);
  assert.doesNotMatch(p, /which the sandbox blocks/);
});
