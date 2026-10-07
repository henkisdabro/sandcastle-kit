// What counts as the same follow-up finding (src/burndown.ts): a place in a title is used as it is, a place
// found only in the evidence or a file with no line counts only beside a title sharing two significant words,
// and a place is a file of the base tree, so `host:port` is not one. A fake tracker and a temp git repo; no
// Docker, model or network.
//
//   pnpm test:file test/followup-place-matching.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createFollowUpBook, fileFollowUps, onBase } = await import("../src/burndown.ts");

const direct = async (fn: () => string) => fn();
const FILES = new Set(["test/pool.test.ts", "site/js/status.js", "status.sh"]);
const exists = (path: string) => FILES.has(path);
const named = (title: string, evidence: string, from = "7", phase = "implement") => ({ title, evidence, from, phase });

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
const fileAll = async (followUps: ReturnType<typeof named>[]) => {
  const { made, comments, tracker } = recording();
  const book = createFollowUpBook({ update: () => {} }, { tracker, dryRun: false, write: direct, exists });
  for (const f of followUps) book.push(f);
  await book.file();
  return { made, comments };
};

test("two findings whose evidence cites the same line, with different titles, are filed as two issues", async () => {
  const { made, comments } = await fileAll([
    named("Flaky timing in pool test", "test/pool.test.ts:40 sleeps 30 ms"),
    named("slotTurn leaks a waiter", "reproduced by test/pool.test.ts:40", "7", "review"),
  ]);
  assert.deepEqual(made, ["Flaky timing in pool test", "slotTurn leaks a waiter"]);
  assert.deepEqual(comments, []);
});

test("a line found only in the evidence still merges findings whose titles share two significant words", async () => {
  const { made, comments } = await fileAll([
    named("Flaky timing in pool test", "test/pool.test.ts:40 sleeps 30 ms"),
    named("Pool test timing is flaky", "same sleep at test/pool.test.ts:40", "7", "review"),
  ]);
  assert.deepEqual(made, ["Flaky timing in pool test"]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "101");
});

test("one shared word is not enough, and a stopword or the path itself is not a shared word", async () => {
  const { made } = await fileAll([
    named("Stale mock with site/js/status.js", "site/js/status.js:3"),
    named("Stale banner without site/js/status.js", "site/js/status.js:3", "7", "review"),
  ]);
  assert.equal(made.length, 2, "`stale` is shared; `with`/`without` and the path are not words");
});

test("a place in the title still merges with the same line in the other's evidence, whatever the titles", async () => {
  const { made, comments } = await fileAll([
    named("Flaky timing in pool test", "test/pool.test.ts:40 sleeps 30 ms"),
    named("slotTurn leaks a waiter (test/pool.test.ts:40)", "", "7", "review"),
  ]);
  assert.deepEqual(made, ["Flaky timing in pool test"]);
  assert.equal(comments.length, 1);
});

test("two titles that both name the same file with no line are one finding when they share two significant words", async () => {
  const { made, comments } = await fileAll([
    named("Stale demo mock in site/js/status.js", ""),
    named("The status demo mock is stale (site/js/status.js)", "", "7", "review"),
  ]);
  assert.deepEqual(made, ["Stale demo mock in site/js/status.js"]);
  assert.equal(comments.length, 1);
});

test("two titles that name the same file with no line and little else are two findings", async () => {
  const { made, comments } = await fileAll([
    named("Stale mock in site/js/status.js", ""),
    named("The website demo still shows AGE (site/js/status.js)", "", "7", "review"),
  ]);
  assert.equal(made.length, 2);
  assert.deepEqual(comments, []);
});

test("a file with no line in one title and a line in the other's still needs the titles to overlap", async () => {
  const same = await fileAll([
    named("Stale demo mock in site/js/status.js", ""),
    named("Demo mock is stale", "site/js/status.js:40", "7", "review"),
  ]);
  assert.equal(same.made.length, 1);
  const other = await fileAll([
    named("Stale demo mock in site/js/status.js", ""),
    named("Leaks a timer", "site/js/status.js:40", "7", "review"),
  ]);
  assert.equal(other.made.length, 2);
});

test("a host and port is not a place, even when the titles overlap", async () => {
  const { made, comments } = await fileAll([
    named("Health check hits api.example.com:443", "api.example.com:443 times out"),
    named("Health check against api.example.com:443 fails", "api.example.com:443 refused", "7", "review"),
  ]);
  assert.equal(made.length, 2);
  assert.deepEqual(comments, []);
});

test("a root-level file is a place", async () => {
  const { made, comments } = await fileAll([
    named("Wrong colour in status.sh:40", ""),
    named("Banner is off", "see status.sh:40", "7", "review"),
  ]);
  assert.equal(made.length, 1);
  assert.equal(comments.length, 1);
});

test("a place in a title found by fileFollowUps alone follows the same rules", async () => {
  const { made, comments, tracker } = recording();
  await fileFollowUps(tracker, [named("Flaky timing in pool test", "test/pool.test.ts:40"), named("slotTurn leaks a waiter", "test/pool.test.ts:40")], { dryRun: false, write: direct, exists });
  assert.equal(made.length, 2);
  assert.deepEqual(comments, []);
});

test("onBase says a file of the base branch exists, and a host, a directory or a missing path does not", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "site"));
  writeFileSync(join(root, "status.sh"), "#!/bin/sh\n");
  writeFileSync(join(root, "site", "index.html"), "<p>\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  const there = onBase(root, "main");
  assert.equal(there("status.sh"), true);
  assert.equal(there("site/index.html"), true);
  assert.equal(there("api.example.com"), false);
  assert.equal(there("site"), false);
  assert.equal(there("site/missing.html"), false);
});

test("the run's follow-up book is given the base tree's check", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /createFollowUpBook\(run, \{[^}]*exists: onBase\(project\.root, project\.baseBranch\)/);
});
