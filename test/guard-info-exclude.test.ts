// .git/info/exclude holds ignore patterns and runs nothing: the operator's own tools append to it
// while a run is live (Claude Code's runtime block), so that must not stop the run. The rest of
// .git/info/ still must.
//
//   pnpm test:file test/guard-info-exclude.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitUnchanged, gitFingerprint } from "../src/guard.ts";

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-guard-exclude-"));
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start"]);
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  return { root, project: { root, baseBranch: "main" } as Project };
};

test("a host-side append to .git/info/exclude does not stop the run", () => {
  const { root, project } = repo();
  writeFileSync(join(root, ".git/info/exclude"), "# existing\n");
  const before = gitFingerprint(project);
  appendFileSync(join(root, ".git/info/exclude"), "# claude-code-runtime\n**/.claude/scheduled_tasks.lock\nworktrees/\n");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
});

test("a .git/info/exclude created mid-run does not stop the run", () => {
  const { root, project } = repo();
  const before = gitFingerprint(project);
  writeFileSync(join(root, ".git/info/exclude"), "worktrees/\n");
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
});

test("a change to .git/info/attributes still stops the run, with exclude changed beside it", () => {
  const { root, project } = repo();
  writeFileSync(join(root, ".git/info/exclude"), "# existing\n");
  writeFileSync(join(root, ".git/info/attributes"), "*.txt text\n");
  const before = gitFingerprint(project);
  appendFileSync(join(root, ".git/info/exclude"), "worktrees/\n");
  appendFileSync(join(root, ".git/info/attributes"), "* merge=evil\n");
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /\.git\/info\/attributes changed .* tampered/);
});

test("a new file under .git/info other than exclude still stops the run", () => {
  const { root, project } = repo();
  const before = gitFingerprint(project);
  writeFileSync(join(root, ".git/info/sparse-checkout"), "/*\n");
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /\.git\/info\/sparse-checkout changed .* tampered/);
});
