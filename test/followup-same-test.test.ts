// Follow-ups that repair passes made about the same failing test are one issue, whichever tickets
// said them: the first is filed for triage, a later one becomes a comment on it naming its ticket.
// A fake tracker that records what it is asked to create and comment on; no Docker, model or network.
//
//   pnpm test:file test/followup-same-test.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { fileFollowUps, testsNamed } = await import("../src/burndown.ts");
type FollowUp = import("../src/burndown.ts").FollowUp;

const direct = async (fn: () => string) => fn();
const noPath = () => false;

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
const file = (tracker: ReturnType<typeof recording>["tracker"], followUps: FollowUp[], o: { dryRun?: boolean } = {}) =>
  fileFollowUps(tracker, followUps, { dryRun: o.dryRun ?? false, write: direct, exists: noPath });

const A: FollowUp = { title: "Timing test flakes under load", evidence: "the clock race in the works test", from: "A", phase: "repair", tests: ["src/a.test.ts > works"] };
const B: FollowUp = { title: "Intermittent red in the gate", evidence: "waits too short on a busy machine", from: "B", phase: "repair", tests: ["src/a.test.ts > works"] };

test("repair follow-ups from two tickets naming the same failing test are one issue and a comment naming the second ticket", async () => {
  const { made, comments, tracker } = recording();
  const filed = await file(tracker, [A, B]);
  assert.deepEqual(made, [A.title]);
  assert.deepEqual(filed.map((f) => f.id), ["101"]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "101");
  assert.match(comments[0].text, /working on #B/);
  assert.match(comments[0].text, /waits too short on a busy machine/);
});

test("the fold holds across separate filings sharing the run's map, as a later turn does", async () => {
  const { made, comments, tracker } = recording();
  const byTest = new Map<string, string>();
  await fileFollowUps(tracker, [A], { dryRun: false, write: direct, exists: noPath, byTest });
  await fileFollowUps(tracker, [B], { dryRun: false, write: direct, exists: noPath, byTest });
  assert.deepEqual(made, [A.title]);
  assert.equal(comments.length, 1);
});

test("repair follow-ups that share no failing test are two issues", async () => {
  const { made, comments, tracker } = recording();
  await file(tracker, [A, { ...B, tests: ["src/b.test.ts > other"] }]);
  assert.deepEqual(made, [A.title, B.title]);
  assert.deepEqual(comments, []);
});

test("independent filings with no shared map file the same test twice", async () => {
  const { made, tracker } = recording();
  await file(tracker, [A]);
  await file(tracker, [B]);
  assert.deepEqual(made, [A.title, B.title]);
});

test("implement follow-ups naming the same test in prose, with no tests tagged, stay two issues", async () => {
  const { made, comments, tracker } = recording();
  const { tests: _a, ...a } = A;
  const { tests: _b, ...b } = B;
  await file(tracker, [{ ...a, phase: "implement" }, { ...b, phase: "implement" }]);
  assert.deepEqual(made, [A.title, B.title]);
  assert.deepEqual(comments, []);
});

test("a dry run lists both follow-ups and comments on none", async () => {
  const { made, comments, tracker } = recording();
  const listed = await file(tracker, [A, B], { dryRun: true });
  assert.deepEqual(listed.map((f) => f.title), [A.title, B.title]);
  assert.deepEqual(made, []);
  assert.deepEqual(comments, []);
});

test("a test shared by a later line of a folded one also folds a third ticket's line", async () => {
  const { made, comments, tracker } = recording();
  const C: FollowUp = { ...B, title: "Third wording", from: "C", tests: ["src/b.test.ts > other"] };
  await file(tracker, [A, { ...B, tests: ["src/a.test.ts > works", "src/b.test.ts > other"] }, C]);
  assert.deepEqual(made, [A.title]);
  assert.deepEqual(comments.map((c) => c.id), ["101", "101"]);
});

test("testsNamed keeps the ids whose test name occurs in the text, for a vitest id and a pytest id", () => {
  const failing = ["src/a.test.ts", "tests/test_x.py::TestX::test_slow", "tests/test_x.py::TestX::test_fast"];
  assert.deepEqual(testsNamed("src/a.test.ts is flaky", failing), ["src/a.test.ts"]);
  assert.deepEqual(testsNamed("test_slow times out under load", failing), ["tests/test_x.py::TestX::test_slow"]);
  assert.deepEqual(testsNamed("test_slow and test_fast", failing), ["tests/test_x.py::TestX::test_slow", "tests/test_x.py::TestX::test_fast"]);
  assert.deepEqual(testsNamed("something unrelated", failing), []);
  assert.deepEqual(testsNamed("anything", []), []);
});
