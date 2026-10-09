// A run that names tickets warns about their blockers against the whole queue: a blocker queued outside the
// named tickets is a wait, not "open but not queued" (#651). blockerProblems' own handling of `inQueue` is held
// by test/queue-lint-named.test.ts; this holds that the run's start passes it.
//
//   pnpm test:file test/run-named-blocker-warning.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("the run's start hands blockerProblems the whole queue's ids", () => {
  const burndown = readFileSync(join(import.meta.dirname, "..", "src/burndown.ts"), "utf8");
  assert.match(burndown, /blockerProblems\(project, tracker, queued, new Set\(whole\.map\(\(t\) => t\.id\)\)\)/);
});
