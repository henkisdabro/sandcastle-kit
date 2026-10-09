// The shared-.git check covers the main worktree's `.git/config.worktree`, which git reads once
// `extensions.worktreeConfig` is on: one created, changed or removed mid-run stops the run, naming the
// file and its keys as a change to `.git/config` does.
//
//   pnpm test:file test/guard-config-worktree.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitUnchanged, gitFingerprint } from "../src/guard.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const root = join(mkdtempSync(join(tmpdir(), "sandcastle-guard-wtconfig-")), "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start"], { env });
  return { project: { root, baseBranch: "main" } as Project, file: join(root, ".git", "config.worktree") };
};

const stopMessage = (project: Project, before: ReturnType<typeof gitFingerprint>) => {
  let said = "";
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), (e: Error) => ((said = e.message), /^STOPPED after #1: /.test(said)));
  return said;
};

test("a config.worktree created mid-run stops the run, naming the file and its keys", () => {
  const { project, file } = repo();
  const before = gitFingerprint(project);
  writeFileSync(file, "[core]\n\tfsmonitor = touch owned\n[filter \"evil\"]\n\tclean = touch owned\n");
  const said = stopMessage(project, before);
  assert.match(said, /\.git\/config\.worktree changed while sandboxes ran/);
  assert.match(said, /In \.git\/config\.worktree: core\.fsmonitor added; filter\.evil\.clean added\./);
  assert.doesNotMatch(said, /touch owned/);
});

test("an empty config.worktree created mid-run stops the run", () => {
  const { project, file } = repo();
  const before = gitFingerprint(project);
  writeFileSync(file, "");
  assert.match(stopMessage(project, before), /\.git\/config\.worktree changed while sandboxes ran.*created, with no key/);
});

test("a config.worktree present at the start and changed or removed mid-run stops the run", () => {
  const { project, file } = repo();
  writeFileSync(file, "[user]\n\tname = A\n");
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
  writeFileSync(file, "[user]\n\tname = B\n");
  assert.match(stopMessage(project, before), /In \.git\/config\.worktree: user\.name: "A" -> "B"/);
  writeFileSync(file, "[user]\n\tname = A\n");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #2"));
  rmSync(file);
  assert.equal(existsSync(file), false);
  assert.match(stopMessage(project, before), /In \.git\/config\.worktree: user\.name removed \(was "A"\)/);
});

test("a run with no config.worktree passes", () => {
  const { project } = repo();
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
});
