// A reviewer reported an out-of-scope problem, and a missing Upgrading note, only in its final
// message: nothing in the closing summary carries a reviewer's prose, so each was found by reading
// the log. The review prompt says plainly that a problem named only in prose is lost. No model calls.
//
//   pnpm exec tsx --test test/review-prose-problems.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const p = readFileSync(join(import.meta.dirname, "..", "prompts", "review.md"), "utf8").replace(/\s+/g, " ");

test("the review prompt says a problem named only in prose is lost", () => {
  assert.match(p, /A problem named only in prose is lost\./);
});

test("each problem is fixed, filed as a ticket, or left as an <unmet> line", () => {
  assert.match(p, /fixed \(if it is in scope/);
  assert.match(p, /filed as a new ticket/);
  assert.match(p, /left as an `<unmet>` line/);
});
