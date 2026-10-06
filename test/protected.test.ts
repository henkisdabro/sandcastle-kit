// protectedChanges (src/guard.ts) in a throwaway repo: which changed paths keep a
// green branch from landing automatically. Pins the current behaviour of the
// default protected paths, configured prefixes and the install-script check on
// package.json; DEFAULT_PROTECTED stays private, so it is tested through here.
//
//   node --test test/protected.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { protectedChanges } from "../src/guard.ts";

const BRANCH = "agent/issue-1";

type Files = Record<string, string>;

// A repo with `base` committed on main, then `change` committed on a branch off it.
// Explicit `-b main` because CI may default to master; identity per command because
// CI has no global git config.
const scenario = (base: Files, change: Files, protectedPaths?: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-protected-"));
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
  return protectedChanges({ root, baseBranch: "main", protectedPaths } as Project, BRANCH);
};

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "demo", scripts }, null, 2) + "\n";

test("an ordinary source change is not protected", () => {
  assert.deepEqual(scenario({ "src/app.ts": "a\n" }, { "src/app.ts": "b\n" }), []);
});

test("a CI workflow change is protected", () => {
  assert.deepEqual(
    scenario({ ".github/workflows/ci.yml": "a\n" }, { ".github/workflows/ci.yml": "b\n" }),
    [".github/workflows/ci.yml"],
  );
});

test("agent settings are protected", () => {
  assert.deepEqual(
    scenario({ ".claude/settings.json": "{}\n" }, { ".claude/settings.json": '{"a":1}\n' }),
    [".claude/settings.json"],
  );
});

test("a configured protectedPaths prefix is protected, and is not without it", () => {
  const base = { "infra/main.tf": "a\n" };
  const change = { "infra/main.tf": "b\n" };
  assert.deepEqual(scenario(base, change, ["infra/"]), ["infra/main.tf"]);
  assert.deepEqual(scenario(base, change, undefined), []);
});

test("a changed install script in the root package.json is protected", () => {
  assert.deepEqual(
    scenario({ "package.json": pkg({ postinstall: "a" }) }, { "package.json": pkg({ postinstall: "b" }) }),
    ["package.json (scripts: postinstall)"],
  );
});

test("a changed non-install script in package.json is not protected", () => {
  assert.deepEqual(
    scenario({ "package.json": pkg({ test: "a" }) }, { "package.json": pkg({ test: "b" }) }),
    [],
  );
});

test("an install script added to a nested package.json is protected", () => {
  assert.deepEqual(
    scenario({ "pkg/web/package.json": pkg({ test: "a" }) }, { "pkg/web/package.json": pkg({ test: "a", prepare: "x" }) }),
    ["pkg/web/package.json (scripts: prepare)"],
  );
});

test("a package.json added on the branch with an install script is protected", () => {
  assert.deepEqual(
    scenario({}, { "package.json": pkg({ preinstall: "x" }) }),
    ["package.json (scripts: preinstall)"],
  );
});
