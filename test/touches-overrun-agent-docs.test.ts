// A change to a project's agent docs (AGENTS.md, CLAUDE.md, at any depth) is not a `Touches:` overrun
// when the branch adds a file: the new module's row in the layout table is expected. On a branch that
// adds nothing, or for any other file, it still is. Temp git repos: no Docker, no gh, no network.
//
//   pnpm test:file test/touches-overrun-agent-docs.test.ts

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
const { isAgentDoc } = await import("../src/touches.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-touches-overrun-agent-docs-"));
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
// main holds src/a.ts, the agent docs and README.md; `agent/issue-1` forks from it and commits `files`.
const overrun = (files: Record<string, string>, body = "Touches: src/a.ts") => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  commit(root, { "src/a.ts": "a\n", "AGENTS.md": "x\n", "CLAUDE.md": "x\n", "docs/AGENTS.md": "x\n", "README.md": "x\n" }, "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  commit(root, files, "work");
  git(root, "checkout", "-q", "main");
  return touchesOverrun(root, "main", git(root, "rev-parse", "agent/issue-1"), body);
};

test("an agent doc changed beside an added file names only the added file", () => {
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "src/new.ts": "n\n", "AGENTS.md": "x2\n" }), ["src/new.ts"]);
});

test("every agent doc counts, at the root or in a directory", () => {
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "src/new.ts": "n\n", "AGENTS.md": "2\n", "CLAUDE.md": "2\n", "docs/AGENTS.md": "2\n" }), ["src/new.ts"]);
});

test("an added agent doc is covered too", () => {
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "pkg/CLAUDE.md": "n\n" }), []);
});

test("an agent doc edited on a branch that adds nothing is still an overrun", () => {
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "AGENTS.md": "x2\n" }), ["AGENTS.md"]);
});

test("any other file is still an overrun beside an added file", () => {
  assert.deepEqual(overrun({ "src/new.ts": "n\n", "AGENTS.md": "2\n", "README.md": "2\n" }), ["README.md", "src/new.ts"]);
});

test("an added test file counts as an added file", () => {
  assert.deepEqual(overrun({ "src/a.ts": "a2\n", "test/new.test.ts": "t\n", "AGENTS.md": "2\n" }), []);
});

test("agent doc paths", () => {
  for (const p of ["AGENTS.md", "CLAUDE.md", "docs/AGENTS.md", "./CLAUDE.md", "a/b/CLAUDE.md"]) assert.ok(isAgentDoc(p), p);
  for (const p of ["README.md", "docs/architecture.md", "AGENTS.md.bak", "MY-AGENTS.md", "agents.md", "src/AGENTS.ts"]) assert.ok(!isAgentDoc(p), p);
});
