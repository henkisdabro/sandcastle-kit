// protectedChanges (src/guard.ts) for commit-hook runners' config: the `lint-staged`, `husky`, `simple-git-hooks`
// and `pre-commit` keys of a package.json, and the file names lefthook, husky 4 and simple-git-hooks read. Their
// commands run on the host at the person's next commit, as `.lintstagedrc`'s do.
//
//   pnpm test:file test/protected-hook-runners.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { protectedChanges, protectedPathsNote } from "../src/guard.ts";

const BRANCH = "agent/issue-1";

type Files = Record<string, string>;

const scenario = (base: Files, change: Files) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hook-runners-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  const commit = (files: Files, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
  };
  git("init", "-q", "-b", "main");
  commit({ "README.md": "base\n", ...base }, "base");
  git("checkout", "-q", "-b", BRANCH);
  commit(change, "change");
  return protectedChanges({ root, baseBranch: "main" } as Project, BRANCH);
};

const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: "demo", version: "1.0.0", ...extra }, null, 2) + "\n";

test("a changed lint-staged command in package.json is held, named by its key", () => {
  assert.deepEqual(
    scenario({ "package.json": pkg({ "lint-staged": { "*.ts": "eslint" } }) }, { "package.json": pkg({ "lint-staged": { "*.ts": "curl x | sh" } }) }),
    ["package.json (lint-staged)"],
  );
});

test("a lint-staged key added to package.json is held", () => {
  assert.deepEqual(scenario({ "package.json": pkg({}) }, { "package.json": pkg({ "lint-staged": { "*": "sh evil.sh" } }) }), ["package.json (lint-staged)"]);
});

test("a changed simple-git-hooks command in package.json is held", () => {
  assert.deepEqual(
    scenario({ "package.json": pkg({ "simple-git-hooks": { "pre-commit": "a" } }) }, { "package.json": pkg({ "simple-git-hooks": { "pre-commit": "b" } }) }),
    ["package.json (simple-git-hooks)"],
  );
});

test("a changed husky 4 hooks command in package.json is held", () => {
  assert.deepEqual(
    scenario({ "package.json": pkg({ husky: { hooks: { "pre-commit": "a" } } }) }, { "package.json": pkg({ husky: { hooks: { "pre-commit": "b" } } }) }),
    ["package.json (husky)"],
  );
});

test("a changed pre-commit key in a nested package.json is held", () => {
  assert.deepEqual(
    scenario({ "pkg/package.json": pkg({ "pre-commit": ["lint"] }) }, { "pkg/package.json": pkg({ "pre-commit": ["lint", "evil"] }) }),
    ["pkg/package.json (pre-commit)"],
  );
});

test("a version bump in package.json is not held", () => {
  assert.deepEqual(
    scenario({ "package.json": pkg({ "lint-staged": { "*.ts": "eslint" } }) }, { "package.json": pkg({ "lint-staged": { "*.ts": "eslint" } }).replace("1.0.0", "1.0.1") }),
    [],
  );
});

test("a script and a hook runner key changed together are both named", () => {
  assert.deepEqual(
    scenario({ "package.json": pkg({ scripts: { postinstall: "a" } }) }, { "package.json": pkg({ scripts: { postinstall: "b" }, "lint-staged": { "*": "x" } }) }),
    ["package.json (scripts: postinstall)", "package.json (lint-staged)"],
  );
});

for (const file of [
  ".lefthook.yml", ".lefthook.yaml", "lefthook.yaml", "lefthook-local.yml", ".lefthook-local.yml", ".lefthook-local.yaml",
  ".config/lefthook.yml", ".config/lefthook.yaml", ".huskyrc", ".huskyrc.json", "husky.config.js",
  ".simple-git-hooks.json", ".simple-git-hooks.cjs", "simple-git-hooks.js",
]) {
  test(`a branch that adds ${file} is held`, () => {
    assert.deepEqual(scenario({}, { [file]: "x\n" }), [file]);
  });
}

test("the agents' protected-paths note names the package.json keys that hold a branch", () => {
  // An agent not told tidies a lint-staged entry on the side, and the branch it spent a pipeline on is held.
  const note = protectedPathsNote({ root: tmpdir(), baseBranch: "main" } as Project, "implement");
  for (const key of ["lint-staged", "husky", "simple-git-hooks", "pre-commit"]) assert.ok(note.includes(`\`${key}\``), key);
  assert.match(note, /`\.huskyrc`/);
});
