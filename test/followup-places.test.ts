// Two follow-ups of one source ticket that name the same `path:line` are one finding, whatever their
// titles: the first is filed for triage, the second becomes a comment on that issue with its evidence.
// Follow-ups of different source tickets stay separate issues. A fake tracker that records what it is
// asked to create and comment on; no Docker, model or network.
//
//   node --test test/followup-places.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createFollowUpBook, fileFollowUps } = await import("../src/burndown.ts");
type FiledFollowUp = import("../src/burndown.ts").FiledFollowUp;
type Places = import("../src/burndown.ts").Places;

const direct = async (fn: () => string) => fn();
const anyPath = () => true;
const named = (title: string, evidence: string, from: string, phase: string) => ({ title, evidence, from, phase });

const recording = (o: { failFirst?: boolean } = {}) => {
  const made: string[] = [];
  const comments: { id: string; text: string }[] = [];
  let down = o.failFirst ?? false;
  return {
    made,
    comments,
    heal: () => (down = false),
    tracker: {
      ref: (id: string) => `#${id}`,
      create: (title: string) => {
        if (down) throw new Error("HTTP 502");
        return String(made.push(title) + 100);
      },
      comment: (id: string, text: string) => void comments.push({ id, text }),
    },
  };
};
const book = (tracker: ReturnType<typeof recording>["tracker"], o: { dryRun?: boolean; seen?: Set<string>; places?: Places } = {}) => {
  const records: FiledFollowUp[][] = [];
  const made = createFollowUpBook({ update: (f) => void records.push(f.followUps) }, { tracker, dryRun: o.dryRun ?? false, write: direct, exists: anyPath, seen: o.seen, places: o.places });
  return { book: made, last: () => records[records.length - 1] ?? [] };
};

const IMPLEMENT = named("Website mock still shows the old banner", "site/index.html:212 draws the old banner", "7", "implement");
const REVIEW = named("Mock banner is stale on the landing page", "same mock, ./site/index.html:212 was not updated", "7", "review");

test("two passes of one ticket naming the same path:line under different titles file one issue and comment on it", async () => {
  const { made, comments, tracker } = recording();
  const { book: b, last } = book(tracker);
  b.push(IMPLEMENT);
  b.push(REVIEW);
  assert.deepEqual(last().map((f) => f.title), [IMPLEMENT.title], "only the first is listed in the record");
  const filed = await b.file();
  assert.deepEqual(made, [IMPLEMENT.title]);
  assert.deepEqual(filed.map((f) => f.id), ["101"]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "101");
  assert.match(comments[0].text, /review agent working on #7/);
  assert.match(comments[0].text, /same mock, \.\/site\/index\.html:212 was not updated/);
  assert.equal((await b.file()).length, 0, "filing again writes nothing more");
  assert.equal(comments.length, 1);
});

test("the place may be named in the title of the second and the evidence of the first", async () => {
  const { made, comments, tracker } = recording();
  const first = named("Stale mock", "see site/index.html:212", "7", "implement");
  const second = named("site/index.html:212 is out of date", "", "7", "review");
  await fileFollowUps(tracker, [first, second], { dryRun: false, write: direct, exists: anyPath });
  assert.deepEqual(made, ["Stale mock"]);
  assert.equal(comments.length, 1);
  assert.match(comments[0].text, /\(no evidence given\)/);
});

test("follow-ups of different source tickets naming the same path:line are still filed separately", async () => {
  const { made, comments, tracker } = recording();
  const { book: b } = book(tracker);
  b.push(IMPLEMENT);
  b.push({ ...REVIEW, from: "8" });
  await b.file();
  assert.deepEqual(made, [IMPLEMENT.title, REVIEW.title]);
  assert.deepEqual(comments, []);
});

test("another line of the same file is another finding", async () => {
  const { made, comments, tracker } = recording();
  const { book: b } = book(tracker);
  b.push(IMPLEMENT);
  b.push(named("Other mock", "site/index.html:213 too", "7", "review"));
  await b.file();
  assert.equal(made.length, 2);
  assert.deepEqual(comments, []);
});

test("a host:port or a word:number is not a place", async () => {
  const { made, comments, tracker } = recording();
  const { book: b } = book(tracker);
  b.push(named("First", "serves on http://example.com:8080 only", "7", "implement"));
  b.push(named("Second", "serves on http://example.com:8080 only; see also step:3", "7", "review"));
  await b.file();
  assert.equal(made.length, 2);
  assert.deepEqual(comments, []);
});

test("a later turn of the run comments on the issue an earlier turn filed", async () => {
  const seen = new Set<string>();
  const places: Places = new Map();
  const { made, comments, tracker } = recording();
  const one = book(tracker, { seen, places });
  one.book.push(IMPLEMENT);
  await one.book.file();
  const two = book(tracker, { seen, places });
  two.book.push(REVIEW);
  assert.deepEqual(two.last(), [], "nothing new is listed");
  await two.book.file();
  assert.deepEqual(made, [IMPLEMENT.title]);
  assert.deepEqual(comments.map((c) => c.id), ["101"]);
});

test("when the first fails to file, the second is not filed as its own issue", async () => {
  const { made, comments, heal, tracker } = recording({ failFirst: true });
  const { book: b } = book(tracker);
  b.push(IMPLEMENT);
  b.push(REVIEW);
  const failed = await b.file();
  assert.deepEqual(failed.map((f) => [f.title, f.failed]), [[IMPLEMENT.title, "HTTP 502"]]);
  assert.deepEqual(made, []);
  assert.deepEqual(comments, []);
  heal();
  // This book does not retry the failed title (a later turn does), and the second stays held behind it.
  assert.deepEqual(await b.file(), []);
  assert.deepEqual(comments, []);
});

test("a dry run lists the first and comments nothing", async () => {
  const { made, comments, tracker } = recording();
  const { book: b, last } = book(tracker, { dryRun: true });
  b.push(IMPLEMENT);
  b.push(REVIEW);
  const listed = await b.file();
  assert.deepEqual(listed.map((f) => f.title), [IMPLEMENT.title]);
  assert.deepEqual(last().map((f) => f.title), [IMPLEMENT.title]);
  assert.deepEqual([made, comments], [[], []]);
});

test("a comment that fails is tried again by the next filing", async () => {
  const { made, comments, tracker } = recording();
  let down = true;
  const flaky = { ...tracker, comment: (id: string, text: string) => (down ? assert.fail("HTTP 502") : tracker.comment(id, text)) };
  const { book: b } = book(flaky);
  b.push(IMPLEMENT);
  b.push(REVIEW);
  await b.file();
  assert.deepEqual(comments, []);
  down = false;
  await b.file();
  assert.deepEqual(made, [IMPLEMENT.title]);
  assert.equal(comments.length, 1);
});
