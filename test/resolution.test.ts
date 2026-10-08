// A conflict resolution is compared with git's own automatic merge: a change to a path that
// merged cleanly is refused. Temp git repos; no Docker, model or network.
//
//   pnpm test:file test/resolution.test.ts

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

/**
 * main and agent/issue-5 both change conflict.txt; main also changes clean.txt and
 * gen/lock.txt, which the branch leaves alone. Returns the repo and the two tips.
 */
const repo = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-resolution-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  write(dir, "conflict.txt", "one\n");
  write(dir, "clean.txt", "a\nb\nc\n");
  write(dir, "gen/lock.txt", "v1\n");
  commit(dir, "base");
  git(dir, "checkout", "-q", "-b", "agent/issue-5");
  write(dir, "conflict.txt", "branch\n");
  write(dir, "mine.txt", "mine\n");
  commit(dir, "branch work");
  const ours = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  write(dir, "conflict.txt", "main\n");
  write(dir, "clean.txt", "a\nb\nc\nlanded by another ticket\n");
  write(dir, "gen/lock.txt", "v2\n");
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

test("a resolution confined to the conflicted file has no stray changes", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs);
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), []);
});

test("a resolution that reverts a cleanly merged file names it", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => write(dir, "clean.txt", "a\nb\nc\n"));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), ["clean.txt"]);
});

test("a resolution that deletes a cleanly merged file names it", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => rmSync(join(dir, "clean.txt")));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), ["clean.txt"]);
});

test("a regenerated generated file is ignored", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => write(dir, "gen/lock.txt", "regenerated\n"));
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved }), ["gen/lock.txt"]);
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved, generated: [{ paths: ["gen/"], regen: "true" }] }), []);
});

test("a git older than 2.38 returns undefined and says so once", (t) => {
  const { dir, ours, theirs } = repo(t);
  const resolved = resolve(dir, theirs, () => write(dir, "clean.txt", "a\nb\nc\n"));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    assert.equal(strayChanges(dir, { ours, theirs, resolved, gitVersion: "git version 2.37.9" }), undefined);
    assert.equal(strayChanges(dir, { ours, theirs, resolved, gitVersion: "git version 2.30.2" }), undefined);
  } finally {
    console.log = log;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2\.38/);
  // 2.38 itself, and a newer major, run the check.
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved, gitVersion: "git version 2.38.0" }), ["clean.txt"]);
  assert.deepEqual(strayChanges(dir, { ours, theirs, resolved, gitVersion: "git version 3.0.0" }), ["clean.txt"]);
});

test("an unknown ref returns undefined instead of throwing", (t) => {
  const { dir, ours, theirs } = repo(t);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    assert.equal(strayChanges(dir, { ours, theirs, resolved: "no-such-ref" }), undefined);
  } finally {
    console.log = log;
  }
});
