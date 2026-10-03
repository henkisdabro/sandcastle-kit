// cleanProject (src/sandbox.ts), the work of `sandcastle clean`, against a throwaway repo: a
// merged branch and a `sandcastle/` scratch branch go, an unmerged one is kept with its commit
// count (and goes with `all`), a branch merged as an equal patch counts as merged, only worktrees
// under .sandcastle/worktrees/ are removed, and the run lock is still held when it returns.
//
//   pnpm exec tsx --test test/clean.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { lockRun } from "../src/guard.ts";
import { cleanProject } from "../src/sandbox.ts";

// Inside a sandbox the kit sets GIT_COMMITTER_* (AGENT_COMMITTER), which beats `-c user.name`;
// drop every identity variable so the commits here are T's wherever the suite runs.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

// Explicit `-b main` because CI may default to master. realpath: git lists worktrees by their
// real path, and macOS's tmpdir is a symlink.
const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-clean-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const commitOn = (branch: string, file: string) => {
    git("checkout", "-q", "-b", branch, "main");
    writeFileSync(join(root, file), `${file}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", `add ${file}`);
    git("checkout", "-q", "main");
  };
  return { project: { root, name: "demo", baseBranch: "main" } as Project, git, commitOn };
};

const branches = (git: (...a: string[]) => string) =>
  git("branch", "--format=%(refname:short)").split("\n").filter(Boolean);

test("merged and scratch branches are deleted, an unmerged one is kept with its commit count", () => {
  const { project, git, commitOn } = repo();
  commitOn("agent/issue-1", "one.txt");
  git("merge", "-q", "--no-ff", "-m", "merge 1", "agent/issue-1");
  git("branch", "sandcastle/gate-base", "main");
  commitOn("agent/issue-2", "two.txt");
  git("checkout", "-q", "agent/issue-2");
  writeFileSync(join(project.root, "two-b.txt"), "b\n");
  git("add", "-A");
  git("commit", "-q", "-m", "more");
  git("checkout", "-q", "main");

  const result = cleanProject(project, false);
  assert.deepEqual(result.deleted.map((d) => d.branch).sort(), ["agent/issue-1", "sandcastle/gate-base"]);
  assert.ok(result.deleted.every((d) => !d.unmerged));
  assert.deepEqual(result.kept, [{ branch: "agent/issue-2", ahead: 2 }]);
  assert.deepEqual(result.worktrees, []);
  assert.deepEqual(branches(git).sort(), ["agent/issue-2", "main"]);
});

test("`all` deletes the unmerged branch too, and says so", () => {
  const { project, git, commitOn } = repo();
  commitOn("agent/issue-2", "two.txt");
  const result = cleanProject(project, true);
  assert.deepEqual(result.deleted, [{ branch: "agent/issue-2", unmerged: true }]);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(branches(git), ["main"]);
});

test("a branch merged as an equal patch (squash) counts as merged", () => {
  const { project, git, commitOn } = repo();
  commitOn("agent/issue-3", "three.txt");
  git("merge", "-q", "--squash", "agent/issue-3");
  git("commit", "-q", "-m", "squash 3");
  const result = cleanProject(project, false);
  assert.deepEqual(result.deleted, [{ branch: "agent/issue-3", unmerged: false }]);
  assert.deepEqual(result.kept, []);
});

test("only worktrees under .sandcastle/worktrees/ are removed, a locked one included", () => {
  const { project, git } = repo();
  mkdirSync(join(project.root, ".sandcastle/worktrees"), { recursive: true });
  const ours = join(project.root, ".sandcastle/worktrees/agent-issue-4");
  const theirs = join(project.root, "..", `${project.root.split("/").at(-1)}-elsewhere`);
  git("worktree", "add", "-q", "-b", "agent/issue-4", ours, "main");
  git("worktree", "lock", "--reason", "sandcastle: live sandbox", ours);
  git("worktree", "add", "-q", "-b", "other", theirs, "main");
  git("worktree", "lock", "--reason", "sandcastle: live sandbox", theirs);

  const result = cleanProject(project, false);
  assert.deepEqual(result.worktrees, [ours]);
  assert.equal(existsSync(ours), false);
  assert.equal(existsSync(theirs), true);
  assert.match(git("worktree", "list", "--porcelain"), /locked sandcastle: live sandbox/);
  assert.deepEqual(result.deleted, [{ branch: "agent/issue-4", unmerged: false }]);
});

test("the run lock is still held when the clean-up returns", () => {
  const { project, commitOn } = repo();
  commitOn("agent/issue-5", "five.txt");
  lockRun(project);
  const lock = join(project.root, ".sandcastle/logs/run.lock");
  assert.ok(existsSync(lock));
  cleanProject(project, true);
  assert.ok(existsSync(lock), "released only at exit, after the last removal");
});
