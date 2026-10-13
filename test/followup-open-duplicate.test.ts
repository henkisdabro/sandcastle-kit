// A follow-up that names the file and the symptom of an open ticket awaiting triage (one a person filed) is a
// comment on that ticket, not a second one. A fake tracker that records what it is asked to create and comment on;
// no Docker, model or network.
//
//   pnpm test:file test/followup-open-duplicate.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { fileFollowUps } = await import("../src/burndown.ts");
type Ticket = import("../src/tracker.ts").Ticket;

const direct = async (fn: () => string) => fn();
const anyPath = () => true;
const named = (title: string, evidence: string, from = "7", phase = "review") => ({ title, evidence, from, phase });

const FLAKY: Ticket = {
  id: "744",
  title: "Flaky test: the idle timer test fails under load",
  body: "The idle timer test sometimes asserts after one tick.\n\nTouches: test/x.test.ts",
  comments: [],
  labels: ["needs-triage"],
};

const recording = (open: () => Ticket[]) => {
  const made: string[] = [];
  const comments: { id: string; text: string }[] = [];
  let reads = 0;
  return {
    made,
    comments,
    reads: () => reads,
    tracker: {
      ref: (id: string) => `#${id}`,
      create: (title: string) => String(made.push(title) + 800),
      comment: (id: string, text: string) => void comments.push({ id, text }),
      open: () => {
        reads++;
        return open();
      },
    },
  };
};
const file = (r: ReturnType<typeof recording>, followUps: ReturnType<typeof named>[]) =>
  fileFollowUps(r.tracker, followUps, { dryRun: false, write: direct, exists: anyPath, triage: "needs-triage" });

test("a follow-up naming the file and symptom of an open triage ticket is a comment on it, not a new ticket", async () => {
  const r = recording(() => [FLAKY]);
  const filed = await file(r, [named("Idle timer test is flaky under load in test/x.test.ts", "it asserts after one tick")]);
  assert.deepEqual(r.made, []);
  assert.deepEqual(filed, []);
  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0].id, "744");
  assert.match(r.comments[0].text, /Named again by the review agent working on #7/);
  assert.match(r.comments[0].text, /it asserts after one tick/);
});

test("a follow-up naming an unrelated path still files a new ticket, and the list is read once for the batch", async () => {
  const r = recording(() => [FLAKY]);
  const filed = await file(r, [
    named("Idle timer test is flaky under load in test/y.test.ts", "it asserts after one tick"),
    named("Another timer test is flaky under load in test/z.test.ts", "it asserts after one tick"),
  ]);
  assert.equal(r.made.length, 2);
  assert.deepEqual(r.comments, []);
  assert.equal(filed.length, 2);
  assert.equal(r.reads(), 1);
});

test("the same file with a different symptom files a new ticket", async () => {
  const r = recording(() => [FLAKY]);
  await file(r, [named("Missing export in test/x.test.ts breaks the typecheck", "tsc fails")]);
  assert.equal(r.made.length, 1);
  assert.deepEqual(r.comments, []);
});

test("a ticket that is not awaiting triage is not a duplicate", async () => {
  const r = recording(() => [{ ...FLAKY, labels: ["ready-for-agent"] }]);
  await file(r, [named("Idle timer test is flaky under load in test/x.test.ts", "evidence")]);
  assert.equal(r.made.length, 1);
});

test("a list that fails files as before", async () => {
  const r = recording(() => {
    throw new Error("HTTP 502");
  });
  const filed = await file(r, [named("Idle timer test is flaky under load in test/x.test.ts", "evidence")]);
  assert.equal(r.made.length, 1);
  assert.equal(filed.length, 1);
});

test("a second follow-up of the same finding comments on the same open ticket", async () => {
  const r = recording(() => [FLAKY]);
  await file(r, [
    named("Idle timer test is flaky under load in test/x.test.ts", "first"),
    named("Idle timer test flakes under heavy load, asserting early", "second, in test/x.test.ts"),
  ]);
  assert.deepEqual(r.made, []);
  assert.deepEqual(r.comments.map((c) => c.id), ["744", "744"]);
});

test("the run hands the book the project's triage label", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8"), /dryRun: DRY_RUN,\n\s+triage: project\.tracker\.triage,/);
});
