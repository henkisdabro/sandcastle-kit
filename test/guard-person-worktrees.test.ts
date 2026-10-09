// The shared-.git check covers the records of worktrees a person made by hand beside a run
// (`.git/worktrees/<name>/`: `commondir`, `gitdir`, `config.worktree`), by content as they stand at the start:
// one present then and changed mid-run stops the run, naming it; one added mid-run passes only as
// `git worktree add` writes it; one removed passes.
//
//   pnpm test:file test/guard-person-worktrees.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import type { Project } from "../src/config.ts";
import { assertGitUnchanged, gitFingerprint } from "../src/guard.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-guard-person-wt-"));
  const root = join(dir, "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  git(root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start");
  const person = (name: string) => {
    const path = join(dir, name);
    git(root, "worktree", "add", "-q", "-b", name, path);
    return { path, record: join(root, ".git", "worktrees", name) };
  };
  return { dir, project: { root, baseBranch: "main" } as Project, person };
};

const stopMessage = (project: Project, before: ReturnType<typeof gitFingerprint>) => {
  let said = "";
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), (e: Error) => ((said = e.message), said.startsWith("STOPPED after #1: ")));
  return said;
};

test("a worktree of your own, untouched, passes", () => {
  const { project, person } = repo();
  person("pr-fix");
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
});

test("a config.worktree added to your worktree's record mid-run stops the run, naming it", () => {
  const { project, person } = repo();
  const { record } = person("pr-fix");
  const before = gitFingerprint(project);
  writeFileSync(join(record, "config.worktree"), "[core]\n\tfsmonitor = touch owned\n");
  const said = stopMessage(project, before);
  assert.match(said, /worktrees\/pr-fix\/config\.worktree added/);
  assert.doesNotMatch(said, /touch owned/);
});

test("a commondir of your worktree's record that changes or goes mid-run stops the run, naming it", () => {
  const { project, person } = repo();
  const { record, path } = person("pr-fix");
  const before = gitFingerprint(project);
  writeFileSync(join(record, "commondir"), `${path}/.git-elsewhere\n`);
  assert.match(stopMessage(project, before), /worktrees\/pr-fix\/commondir changed/);
  rmSync(join(record, "commondir"));
  assert.match(stopMessage(project, before), /worktrees\/pr-fix\/commondir removed/);
});

test("a gitdir of your worktree's record that changes mid-run stops the run, naming it", () => {
  const { project, person } = repo();
  const { record } = person("pr-fix");
  const before = gitFingerprint(project);
  writeFileSync(join(record, "gitdir"), "/somewhere/else/.git\n");
  assert.match(stopMessage(project, before), /worktrees\/pr-fix\/gitdir changed/);
});

test("a config.worktree present at the start and changed mid-run stops the run, one that stays the same passes", () => {
  const { project, person } = repo();
  const { record } = person("pr-fix");
  writeFileSync(join(record, "config.worktree"), "[user]\n\tname = A\n");
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
  writeFileSync(join(record, "config.worktree"), "[user]\n\tname = B\n");
  assert.match(stopMessage(project, before), /worktrees\/pr-fix\/config\.worktree changed/);
});

test("a worktree you add mid-run with git worktree add passes", () => {
  const { project, person } = repo();
  const before = gitFingerprint(project);
  person("pr-fix");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
});

test("a record added mid-run with a commondir git does not write, or a config.worktree, stops the run", () => {
  const { project, person } = repo();
  const before = gitFingerprint(project);
  const { record } = person("pr-fix");
  writeFileSync(join(record, "config.worktree"), "[user]\n\tname = A\n");
  assert.match(stopMessage(project, before), /worktrees\/pr-fix\/config\.worktree added/);
  rmSync(join(record, "config.worktree"));
  writeFileSync(join(record, "commondir"), "../../elsewhere\n");
  assert.match(stopMessage(project, before), /worktrees\/pr-fix\/commondir is not \.\.\/\.\., which git writes/);
});

test("a worktree git is still writing as a check reads it passes that check and the next", async () => {
  const { dir, project } = repo();
  const before = gitFingerprint(project);
  // git writes the record's gitdir, then its commondir, just after the directory: the check reads it in between and
  // waits for the rest. What it then expects is the record as it passed, not the half-written one it first read.
  const record = join(project.root, ".git", "worktrees", "pr-fix");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "gitdir"), `${join(dir, "pr-fix", ".git")}\n`);
  const writer = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     parentPort.postMessage("ready");
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
     require("node:fs").writeFileSync(workerData, "../..\\n");`,
    { eval: true, workerData: join(record, "commondir") },
  );
  await once(writer, "message");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
  await once(writer, "exit");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #2"));
});

test("a record added mid-run is watched from then on", () => {
  const { project, person } = repo();
  const before = gitFingerprint(project);
  const { record } = person("pr-fix");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
  writeFileSync(join(record, "gitdir"), "/somewhere/else/.git\n");
  assert.match(stopMessage(project, before), /worktrees\/pr-fix\/gitdir changed/);
});

test("a worktree of your own removed mid-run passes", () => {
  const { project, person } = repo();
  const { path } = person("pr-fix");
  const before = gitFingerprint(project);
  git(project.root, "worktree", "remove", path);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
});

test("a kit sandbox's worktree added mid-run is left to the kit's own checks", () => {
  const { project } = repo();
  const before = gitFingerprint(project);
  git(project.root, "worktree", "add", "-q", "-b", "agent/issue-1", join(project.root, ".sandcastle", "worktrees", "agent-issue-1"));
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
  assert.deepEqual(Object.keys(gitFingerprint(project).records), []);
});
