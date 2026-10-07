// Two things the prompts say since a run's reviews let them through: an implementer moved existing
// tests off an 80-column check to fit a narrower column, and its reviewer called the edits "only
// shortened"; another reviewer filed a regression its own branch caused as a follow-up instead of
// fixing it. No Docker, model or network.
//
//   node --test test/prompt-test-weakening.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (name: string) => readFileSync(join(import.meta.dirname, "..", "prompts", name), "utf8").replace(/\s+/g, " ");

test("an existing test's expected text or fixture changed to pass counts as weakening it", () => {
  assert.match(read("implement.md"), /Changing an existing test's expected text or fixture so it passes \(a terminal width, a timeout, a sample\) weakens it too/);
  assert.match(read("review.md"), /An existing test whose expected text or fixture the branch changed to fit .* is weakened unless the ticket changes that behaviour/);
});

test("a reviewer fixes a side effect its branch causes instead of filing it", () => {
  assert.match(read("review.md"), /A side effect of this branch outside the ticket .* is a regression it causes \(item 1\): fix it here\./);
});
