// Two follow-ups of one source ticket that name no file are one finding when their titles share three
// significant words: the first is filed, the second becomes a comment on it. Different source tickets stay
// separate. A fake tracker that records what it is asked to create and comment on; no Docker, model or network.
//
//   node --test test/followup-no-place.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createFollowUpBook, fileFollowUps } = await import("../src/burndown.ts");

const direct = async (fn: () => string) => fn();
const anyPath = () => true;
const named = (title: string, evidence: string, from: string, phase: string) => ({ title, evidence, from, phase });

const recording = () => {
  const made: string[] = [];
  const comments: { id: string; text: string }[] = [];
  return {
    made,
    comments,
    tracker: {
      ref: (id: string) => `#${id}`,
      create: (title: string) => String(made.push(title) + 100),
      comment: (id: string, text: string) => void comments.push({ id, text }),
    },
  };
};

// The ticket's own two wordings: they share exactly three significant words (coverage, test, pool).
const IMPLEMENT = named("Coverage run fails under the test pool", "c8 exits 1 when the pool is used", "7", "implement");
const REVIEW = named("Unit-test coverage cannot run under the test pool", "the coverage step dies in the pool", "7", "review");

test("one ticket's two passes wording a path-less finding differently file one issue and comment on it", async () => {
  const { made, comments, tracker } = recording();
  await fileFollowUps(tracker, [IMPLEMENT, REVIEW], { dryRun: false, write: direct, exists: anyPath });
  assert.deepEqual(made, [IMPLEMENT.title]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "101");
  assert.match(comments[0].text, /review agent working on #7/);
  assert.match(comments[0].text, /the coverage step dies in the pool/);
});

test("the same two titles from different source tickets are filed separately", async () => {
  const { made, comments, tracker } = recording();
  await fileFollowUps(tracker, [IMPLEMENT, { ...REVIEW, from: "8" }], { dryRun: false, write: direct, exists: anyPath });
  assert.deepEqual(made, [IMPLEMENT.title, REVIEW.title]);
  assert.deepEqual(comments, []);
});

test("path-less titles of one ticket sharing only two significant words are filed separately", async () => {
  const { made, comments, tracker } = recording();
  const other = named("Test pool leaks a worker on exit", "", "7", "review"); // shares test, pool
  await fileFollowUps(tracker, [IMPLEMENT, other], { dryRun: false, write: direct, exists: anyPath });
  assert.equal(made.length, 2);
  assert.deepEqual(comments, []);
});

test("through the follow-up book, the second wording is held and commented on once the first is filed", async () => {
  const { made, comments, tracker } = recording();
  const records: { title: string }[][] = [];
  const book = createFollowUpBook({ update: (f) => void records.push(f.followUps) }, { tracker, dryRun: false, write: direct, exists: anyPath });
  book.push(IMPLEMENT);
  book.push(REVIEW);
  assert.deepEqual(records[records.length - 1].map((f) => f.title), [IMPLEMENT.title]);
  await book.file();
  assert.deepEqual(made, [IMPLEMENT.title]);
  assert.equal(comments.length, 1);
});
