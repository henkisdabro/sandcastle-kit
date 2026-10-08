// A conflict resolution is held only for a path the base side changed since the merge base: that is
// the only place another ticket's landed lines can be lost. A brand-new file, or a file only the
// ticket's own branch has touched, can carry none, so it goes to the narrow review instead.
// Temp git repos; no Docker, model or network.
//
//   pnpm test:file test/resolution-base-side.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strayChanges } from "../src/resolution.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const write = (cwd: string, file: string, text: string) => {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
};

const commit = (cwd: string, message: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
};

const BODY = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";

/**
 * The merge base has conflict.txt, shared.txt, branch-touched.txt and moved.txt. The branch (ours) changes
 * conflict.txt, adds branch-new.txt, edits branch-touched.txt and renames moved.txt to moved-here.txt.
 * main (theirs) changes conflict.txt and shared.txt, edits moved.txt, adds main-new.txt. Both make the same
 * edit to same.txt, so it merges cleanly.
 */
const repo = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-resolution-side-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  write(dir, "conflict.txt", "one\n");
  write(dir, "shared.txt", BODY);
  write(dir, "branch-touched.txt", BODY);
  write(dir, "moved.txt", BODY);
  write(dir, "same.txt", BODY);
  commit(dir, "base");
  git(dir, "checkout", "-q", "-b", "agent/issue-5");
  write(dir, "conflict.txt", "branch\n");
  write(dir, "branch-new.txt", "made by the branch\n");
  write(dir, "branch-touched.txt", BODY.replace("l1\n", "l1 by the branch\n"));
  write(dir, "same.txt", BODY.replace("l9\n", "l9 by both\n"));
  git(dir, "mv", "moved.txt", "moved-here.txt");
  commit(dir, "branch work");
  const ours = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  write(dir, "conflict.txt", "main\n");
  write(dir, "shared.txt", BODY.replace("l9\n", "l9 landed by another ticket\n"));
  write(dir, "moved.txt", BODY.replace("l9\n", "l9 landed by another ticket\n"));
  write(dir, "same.txt", BODY.replace("l9\n", "l9 by both\n"));
  write(dir, "main-new.txt", "landed by another ticket\n");
  commit(dir, "main work");
  const theirs = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "agent/issue-5");
  return { dir, ours, theirs };
};

/** The merge a resolver finishes: conflict.txt resolved, then `more` applied before the commit. */
const resolve = (dir: string, theirs: string, more: () => void = () => {}) => {
  try {
    git(dir, "merge", "--no-edit", theirs);
  } catch {
    // The conflict is the point.
  }
  write(dir, "conflict.txt", "both\n");
  more();
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--no-edit");
  return git(dir, "rev-parse", "HEAD");
};

test("a resolution that adds a new file is not held", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => write(dir, "test/added-in-the-merge.test.ts", "exists on neither parent\n"));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), []);
});

test("a resolution that changes a file only the branch created is not held", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => write(dir, "branch-new.txt", "made by the branch, then adapted\n"));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), []);
});

test("a resolution that changes a file only the branch edited, which the base never touched, is not held", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => write(dir, "branch-touched.txt", "rewritten\n"));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), []);
});

test("a resolution that deletes a file only the branch created is not held", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => rmSync(join(dir, "branch-new.txt")));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), []);
});

test("a resolution that changes a file the base changed outside the conflict is still held", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => write(dir, "shared.txt", BODY));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), ["shared.txt"]);
});

test("a resolution that drops a file the base added is still held", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => rmSync(join(dir, "main-new.txt")));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), ["main-new.txt"]);
});

test("a file both sides changed the same way is still held: the base changed it", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => write(dir, "same.txt", BODY));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), ["same.txt"]);
});

test("a file the branch renamed, which the base edited, is still held: the rename carried the base's lines", (t) => {
  const { dir, ours, theirs } = repo(t);
  // The base's edit followed moved.txt to moved-here.txt; reverting it there drops the other ticket's line.
  const resolved = resolve(dir, theirs, () => write(dir, "moved-here.txt", BODY));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), ["moved-here.txt"]);
});

test("a mix names only the paths the base changed", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => {
    write(dir, "added.txt", "new\n");
    write(dir, "branch-new.txt", "adapted\n");
    write(dir, "shared.txt", BODY);
  });
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), ["shared.txt"]);
});
