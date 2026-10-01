// Tickets whose existing branches change a shared file do not start in the
// same run (fileOverlaps in src/burndown.ts): one per group starts, the rest
// wait. Real git in a temp repo; no Docker, model calls or network.
//
//   pnpm exec tsx --test test/overlap.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing burndown.ts must not touch the real config or cache.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { fileOverlaps } = await import("../src/burndown.ts");

// A fresh repo on `main` with one commit, and helpers to branch and commit.
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-overlap-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  const commit = (files: string[], message: string) => {
    for (const f of files) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), `${message}\n`);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  // A branch off the current main that changes `files`, then back to main.
  const branch = (id: string, files: string[]) => {
    git("branch", `agent/issue-${id}`, "main");
    git("checkout", "-q", `agent/issue-${id}`);
    commit(files, `issue ${id}`);
    git("checkout", "-q", "main");
  };
  commit(["README.md"], "init");
  return { root, git, commit, branch };
};

test("a ticket sharing a file with an earlier one waits; a new ticket is never held", () => {
  const r = repo();
  r.branch("1", ["site.css"]);
  r.branch("2", ["site.css", "app.ts"]);
  r.branch("3", ["other.ts"]);
  assert.deepEqual(fileOverlaps(r.root, "main", ["1", "2", "3", "4"]), [{ id: "2", with: "1", files: ["site.css"] }]);
});

test("the order given decides which of a group starts", () => {
  const r = repo();
  r.branch("1", ["site.css"]);
  r.branch("2", ["site.css", "app.ts"]);
  r.branch("3", ["other.ts"]);
  assert.deepEqual(fileOverlaps(r.root, "main", ["2", "1", "3"]), [{ id: "1", with: "2", files: ["site.css"] }]);
});

test("a held ticket holds nobody else", () => {
  const r = repo();
  r.branch("1", ["a"]);
  r.branch("2", ["a", "b"]);
  r.branch("3", ["b"]);
  assert.deepEqual(fileOverlaps(r.root, "main", ["1", "2", "3"]), [{ id: "2", with: "1", files: ["a"] }]);
});

test("a three-way overlap starts one and holds two, both naming the first", () => {
  const r = repo();
  for (const id of ["1", "2", "3"]) r.branch(id, ["a"]);
  assert.deepEqual(fileOverlaps(r.root, "main", ["1", "2", "3"]), [
    { id: "2", with: "1", files: ["a"] },
    { id: "3", with: "1", files: ["a"] },
  ]);
});

test("a branch already merged into main constrains nothing", () => {
  const r = repo();
  r.branch("1", ["a"]);
  r.git("merge", "-q", "--no-ff", "-m", "merge 1", "agent/issue-1");
  r.commit(["later.txt"], "main moves on");
  r.branch("2", ["a"]);
  assert.deepEqual(fileOverlaps(r.root, "main", ["1", "2"]), []);
});

test("three dots, not two: what main changed after a branch forked is not the branch's", () => {
  const r = repo();
  r.branch("1", ["x.txt"]);
  r.commit(["shared.txt"], "main changes shared.txt");
  r.branch("2", ["shared.txt"]);
  assert.deepEqual(fileOverlaps(r.root, "main", ["1", "2"]), []);
});

test("nothing to compare when no ticket has a branch", () => {
  const r = repo();
  assert.deepEqual(fileOverlaps(r.root, "main", ["1", "2", "3"]), []);
});
