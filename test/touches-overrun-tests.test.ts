// A test file the branch adds is not an overrun of the `Touches:` line (its name cannot be known when
// the ticket is written); a modified test file, or an added file elsewhere, still is. Temp git repos:
// no Docker, no gh, no network.
//
//   pnpm test:file test/touches-overrun-tests.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { touchesOverrun } = await import("../src/landing.ts");
const { isTestPath } = await import("../src/touches.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-touches-overrun-tests-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = (root: string, files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
};
// main holds src/a.ts and test/x.test.ts; `agent/issue-1` forks from it and commits `files`.
const overrun = (files: Record<string, string>, body = "Touches: src/a.ts") => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  commit(root, { "src/a.ts": "a\n", "test/x.test.ts": "x\n" }, "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  commit(root, files, "work");
  git(root, "checkout", "-q", "main");
  return touchesOverrun(root, "main", git(root, "rev-parse", "agent/issue-1"), body);
};

test("an added test file is not an overrun", () => {
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "test/new-thing.test.ts": "t\n" }), []);
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "pkg/__tests__/deep/t.ts": "t\n", "lib/foo.spec.js": "t\n", "x/y_test.go": "t\n", "py/test_a.py": "t\n" }), []);
});

test("an added source file is still an overrun, beside an added test", () => {
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "src/new.ts": "n\n", "test/new.test.ts": "t\n" }), ["src/new.ts"]);
});

test("a modified test file outside the line is still an overrun", () => {
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "test/x.test.ts": "x2\n" }), ["test/x.test.ts"]);
});

test("conventional test paths", () => {
  for (const p of ["test/a.ts", "tests/a/b.ts", "a/__tests__/b.js", "a.test.ts", "a.spec.tsx", "pkg/a_test.go", "test_a.py", "a_test.py"]) assert.ok(isTestPath(p), p);
  for (const p of ["src/a.ts", "src/testing/a.ts", "src/latest.ts", "docs/test.md", "a.test", "contest/a.ts"]) assert.ok(!isTestPath(p), p);
});
