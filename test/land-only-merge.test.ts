// A branch past its recorded green head by merge commits only (the kit's base merge, a conflict
// resolution a hold left on it) still lands land-only; a commit of its own since green runs in full.
// Temp git repos; no Docker, model or network.
//
//   node --test test/land-only-merge.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { landOnlyHead, narrowReviewBase, recordHead } = await import("../src/run.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
};

/** main with a.txt, and agent/issue-5 one commit ahead of it, recorded reviewed and green at its tip. */
const repo = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-landonly-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  commit(dir, "a.txt", "a\n");
  git(dir, "checkout", "-q", "-b", "agent/issue-5");
  commit(dir, "b.txt", "b\n");
  const green = git(dir, "rev-parse", "HEAD");
  recordHead(dir, "5", { branch: "agent/issue-5", reviewed: green, green }, "run-1");
  return { dir, green };
};

/** Moves main on and merges it into the branch, leaving the branch's tip a merge commit. */
const mergeBase = (dir: string, file = "c.txt") => {
  git(dir, "checkout", "-q", "main");
  commit(dir, file, "c\n");
  git(dir, "checkout", "-q", "agent/issue-5");
  git(dir, "merge", "-q", "--no-edit", "main");
};

test("a branch past its green head by a base merge only still lands only, at the green head", (t) => {
  const { dir, green } = repo(t);
  mergeBase(dir);
  assert.notEqual(git(dir, "rev-parse", "agent/issue-5"), green);
  assert.equal(landOnlyHead(dir, "main", "5"), green);
});

test("a conflict resolution left on the branch by a hold is merge-only too", (t) => {
  const { dir, green } = repo(t);
  git(dir, "checkout", "-q", "main");
  commit(dir, "b.txt", "main's b\n");
  git(dir, "checkout", "-q", "agent/issue-5");
  assert.throws(() => git(dir, "merge", "--no-edit", "main"));
  writeFileSync(join(dir, "b.txt"), "resolved\n");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-q", "--no-edit");
  assert.equal(landOnlyHead(dir, "main", "5"), green);
});

test("a commit of the branch's own after the merge runs in full", (t) => {
  const { dir } = repo(t);
  mergeBase(dir);
  commit(dir, "d.txt", "d\n");
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
});

test("a commit of the branch's own before the merge runs in full", (t) => {
  const { dir } = repo(t);
  commit(dir, "d.txt", "d\n");
  mergeBase(dir);
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
});

test("a rewritten branch, whose green head left its history, runs in full", (t) => {
  const { dir } = repo(t);
  mergeBase(dir);
  git(dir, "checkout", "-q", "--orphan", "rewritten");
  commit(dir, "z.txt", "z\n");
  git(dir, "branch", "-M", "agent/issue-5");
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
});

test("a merge-only branch whose work is all on base runs in full", (t) => {
  const { dir } = repo(t);
  mergeBase(dir);
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--ff-only", "agent/issue-5");
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
});

test("the narrow review base after a merge-only history stays the reviewed head", (t) => {
  const { dir, green } = repo(t);
  mergeBase(dir);
  assert.equal(narrowReviewBase(dir, "main", "5"), green);
});
