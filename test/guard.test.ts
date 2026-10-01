// The shared-.git check (src/guard.ts) in a throwaway repo: a moved base
// branch and a changed .git/config are told apart, and each says what moved.
//
//   pnpm exec tsx --test test/guard.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitUnchanged, gitFingerprint } from "../src/guard.ts";

// Inside a sandbox the kit sets GIT_COMMITTER_* (AGENT_COMMITTER), which beats `-c user.name`;
// drop every identity variable so the commits here are T's wherever the suite runs.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-guard-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", env });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  return { project: { root, baseBranch: "main" } as Project, git };
};

test("a commit on the base branch stops the run, naming the commit, not tampering", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "before landing"));
  writeFileSync(join(project.root, "ticket.md"), "Status: wontfix\n");
  git("add", "ticket.md");
  git("commit", "-q", "-m", "demo-06: not needed after all");
  assert.throws(() => assertGitUnchanged(project, before, "before landing"), (e: Error) => {
    assert.match(e.message, /^STOPPED before landing: main moved while sandboxes ran \([0-9a-f]+ by T, .*: demo-06: not needed after all; changes ticket\.md\)/);
    assert.match(e.message, /Check the commits are yours/);
    assert.doesNotMatch(e.message, /tampered/);
    return true;
  });
});

test("a planted commit subject cannot carry terminal escapes into the message", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("commit", "-q", "--allow-empty", "-m", "fix\u001b]0;owned\u0007 it");
  assert.throws(() => assertGitUnchanged(project, before, "before landing"), (e: Error) => !/[\u0000-\u001f]/.test(e.message.replace(/\n/g, "")));
});

test("a changed .git/config is tampering", () => {
  const { project, git } = repo();
  const before = gitFingerprint(project);
  git("config", "core.fsmonitor", "touch /tmp/owned");
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /STOPPED after #1: \.git\/config changed .* tampered/);
});

test("a new file under .git/info is tampering", () => {
  const { project } = repo();
  const before = gitFingerprint(project);
  writeFileSync(join(project.root, ".git/info/attributes"), "* filter=evil\n");
  assert.throws(() => assertGitUnchanged(project, before, "before landing"), /tampered/);
});
