// Which comments are past a carried branch's review. On GitHub the head record keeps the time of the latest comment
// the review read (`commentsAt`) and a comment is unseen when created after it, so a deleted comment that moved the
// count back cannot hide a trusted comment. A ticket file has no times and keeps the count.
//
//   pnpm test:file test/comments-since-time.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { personCommentsSince, seenComments, trustOf } = await import("../src/ledger.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

type C = [login: string, association: string, at: string | undefined, text: string];
const thread = (...c: C[]) => ({
  comments: c.map((x) => x[3]),
  commentBy: c.map((x) => ({ login: x[0], association: x[1], ...(x[2] ? { at: x[2] } : {}) })),
  author: "reporter",
});

const T1 = "2026-10-01T10:00:00Z";
const T2 = "2026-10-02T10:00:00Z";
const T3 = "2026-10-03T10:00:00Z";

test("a maintainer's comment made after the review counts even when a deleted outsider's comment moved the count back", () => {
  // At the review: the outsider's comment (T1) and a maintainer's (T2) were read, so 2 were counted. The outsider
  // deleted theirs, and the maintainer corrected themselves at T3: now two comments, the new one at index 1.
  const now = thread(["maintainer", "OWNER", T2, "first note"], ["maintainer", "OWNER", T3, "Correction: use the other flag."]);
  assert.deepEqual(personCommentsSince(now.comments, 2, trustOf(now, null)), []);
  assert.deepEqual(personCommentsSince(now.comments, 2, trustOf(now, null), T2), ["Correction: use the other flag."]);
});

test("a comment created before the recorded time does not count, whatever its index", () => {
  const now = thread(["maintainer", "OWNER", T1, "old"], ["maintainer", "OWNER", T2, "also old"], ["maintainer", "OWNER", T3, "new"]);
  assert.deepEqual(personCommentsSince(now.comments, 0, trustOf(now, null), T2), ["new"]);
  assert.deepEqual(personCommentsSince(now.comments, 0, trustOf(now, null), T3), []);
});

test("an outsider's later comment still counts for nothing when times are used", () => {
  const now = thread(["maintainer", "OWNER", T1, "read"], ["stranger", "NONE", T3, "Please also do this."]);
  assert.deepEqual(personCommentsSince(now.comments, 1, trustOf(now, null), T1), []);
});

test("with no time recorded (a head from before it) the count rule applies", () => {
  const now = thread(["maintainer", "OWNER", T2, "first note"], ["maintainer", "OWNER", T3, "Correction"]);
  assert.deepEqual(personCommentsSince(now.comments, 2, trustOf(now, null), undefined), []);
  assert.deepEqual(personCommentsSince(now.comments, 1, trustOf(now, null), undefined), ["Correction"]);
  assert.deepEqual(personCommentsSince(now.comments, undefined, trustOf(now, null), T1), []);
});

test("a ticket file's comments, which carry no time, keep the count rule", () => {
  const section = ["## Comments", "", "### 2026-10-01 - sandcastle", "kit", "", "### 2026-10-02 - alice", "Please redo it."].join("\n");
  assert.deepEqual(personCommentsSince([section], 1), ["Please redo it."]);
  assert.deepEqual(personCommentsSince([section], 1, undefined, T1), ["Please redo it."]);
  assert.deepEqual(personCommentsSince([section], 2, undefined, T1), []);
});

test("a thread where one comment has no time is read by count", () => {
  const now = thread(["maintainer", "OWNER", undefined, "no time"], ["maintainer", "OWNER", T3, "new"]);
  assert.deepEqual(personCommentsSince(now.comments, 1, trustOf(now, null), T3), ["new"]);
});

test("the record a full review keeps carries the latest comment time for a GitHub ticket and none for a ticket file", () => {
  const gh = thread(["maintainer", "OWNER", T2, "a"], ["maintainer", "OWNER", T3, "b"], ["stranger", "NONE", T1, "c"]);
  assert.deepEqual(seenComments(gh), { comments: 3, commentsAt: T3 });
  assert.deepEqual(seenComments({ comments: ["plain"] }), { comments: 1, commentsAt: undefined });
  assert.deepEqual(seenComments({ comments: [], commentBy: [] }), { comments: 0, commentsAt: undefined });
});

test("burndown records the review's comment time and hands it to every late-comment check", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /\.\.\.\(seenThread \? seenComments\(seenThread\) : \{\}\)/);
  assert.equal(source.match(/\]\?\.commentsAt\)/g)?.length, 2);
});

test("the GitHub tracker keeps each comment's creation time from the comments it already reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-comments-since-"));
  writeFileSync(join(dir, "gh"), `#!/bin/sh\ncat '${join(dir, "listed.json")}'\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const comment = (login: string, createdAt?: string) => ({ body: "x", author: { login }, authorAssociation: "OWNER", ...(createdAt ? { createdAt } : {}) });
  writeFileSync(
    join(dir, "listed.json"),
    JSON.stringify([{ number: 7, title: "seven", body: "", author: { login: "reporter" }, updatedAt: T3, labels: [{ name: "ready-for-agent" }], comments: [comment("a", T1), comment("b")] }]),
  );
  const project = { root: dir, name: "t", baseBranch: "main", label: "ready-for-agent", tracker: fakeTracker() } as unknown as Project;
  const before = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${before}`;
  try {
    const [t] = makeTracker(project).queued();
    assert.deepEqual(t.commentBy, [
      { login: "a", association: "OWNER", at: T1 },
      { login: "b", association: "OWNER" },
    ]);
  } finally {
    process.env.PATH = before;
  }
});
