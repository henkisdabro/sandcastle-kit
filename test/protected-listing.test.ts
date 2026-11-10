// protectedChanges (src/guard.ts) lists a branch's changes the way a caller of a landing sees them: a protected
// file renamed away and a protected path with a non-ASCII name are held like any other, and every default entry
// holds a branch (dropping one from DEFAULT_PROTECTED turns a row red).
//
//   pnpm test:file test/protected-listing.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { protectedChanges } from "../src/guard.ts";

const BRANCH = "agent/issue-1";

// A repo with `base` on main; `change` runs in the checkout on a branch off it and its result is committed.
const scenario = (base: Record<string, string>, change: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-protected-listing-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  const write = (name: string, content: string) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  };
  git("init", "-q", "-b", "main");
  for (const [name, content] of Object.entries({ "README.md": "base\n", ...base })) write(name, content);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", BRANCH);
  change(root);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "change");
  return protectedChanges({ root, baseBranch: "main" } as Project, BRANCH);
};

const put = (root: string, name: string, content: string) => {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
};

test("a branch that renames a workflow out of .github/ is held for the workflow's old path", () => {
  const hits = scenario({ ".github/workflows/ci.yml": "name: ci\non: push\n" }, (root) => {
    mkdirSync(join(root, "docs"));
    renameSync(join(root, ".github/workflows/ci.yml"), join(root, "docs/ci.yml.off"));
  });
  assert.deepEqual(hits, [".github/workflows/ci.yml"]);
});

test("a branch that moves a hook out of .husky/ is held", () => {
  const hits = scenario({ ".husky/pre-commit": "npm test\n" }, (root) => {
    renameSync(join(root, ".husky/pre-commit"), join(root, "pre-commit.sample"));
  });
  assert.deepEqual(hits, [".husky/pre-commit"]);
});

test("a new workflow with a non-ASCII name is held, named as it is on disk", () => {
  const hits = scenario({}, (root) => put(root, ".github/workflows/déploy.yml", "on: push\n"));
  assert.deepEqual(hits, [".github/workflows/déploy.yml"]);
});

// One changed file per default entry. A directory entry gets a file in it, "lint-staged.config." a real config name.
const ENTRIES: [string, string][] = [
  [".husky/", ".husky/pre-commit"],
  [".githooks/", ".githooks/pre-commit"],
  [".github/", ".github/workflows/ci.yml"],
  [".gitmodules", ".gitmodules"],
  [".gitattributes", ".gitattributes"],
  [".claude/settings.json", ".claude/settings.json"],
  [".claude/settings.local.json", ".claude/settings.local.json"],
  [".claude/hooks/", ".claude/hooks/guard.sh"],
  [".mcp.json", ".mcp.json"],
  [".codex/", ".codex/config.toml"],
  [".agents/", ".agents/skills/a.md"],
  [".sandcastle/", ".sandcastle/config.json"],
  [".npmrc", ".npmrc"],
  ["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
  [".yarnrc.yml", ".yarnrc.yml"],
  [".lintstagedrc", ".lintstagedrc"],
  ["lint-staged.config.", "lint-staged.config.js"],
  [".pre-commit-config.yaml", ".pre-commit-config.yaml"],
  ["lefthook.yml", "lefthook.yml"],
];

for (const [entry, file] of ENTRIES) {
  test(`a change to ${file} is held (default entry ${entry})`, () => {
    assert.deepEqual(scenario({}, (root) => put(root, file, "x\n")), [file]);
  });
}
