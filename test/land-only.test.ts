// The land-only check (a carried branch still at its recorded green head skips
// implement and review) and the resolver prompt that finishes a conflicted base
// merge. Temp git repos and temp directories; no Docker, model or network.
//
//   pnpm exec tsx --test test/land-only.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Importing run.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { landOnlyHead, recordHead, renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
};

/** A repo with main and agent/issue-5 one commit ahead of it. */
const repo = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-landonly-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  commit(dir, "a.txt", "a\n");
  git(dir, "checkout", "-q", "-b", "agent/issue-5");
  commit(dir, "b.txt", "b\n");
  return dir;
};

const tip = (dir: string) => git(dir, "rev-parse", "agent/issue-5");

test("a branch still at its green head, with work not on base, lands only", (t) => {
  const dir = repo(t);
  recordHead(dir, "5", { branch: "agent/issue-5", green: tip(dir) }, "run-1");
  assert.equal(landOnlyHead(dir, "main", "5"), tip(dir));
});

test("no record, no green field, or another branch's record runs in full", (t) => {
  const dir = repo(t);
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
  recordHead(dir, "5", { branch: "agent/issue-5", reviewed: tip(dir) }, "run-1");
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
  recordHead(dir, "5", { branch: "agent/issue-6", green: tip(dir) }, "run-2");
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
});

test("a commit after the record runs in full", (t) => {
  const dir = repo(t);
  recordHead(dir, "5", { branch: "agent/issue-5", green: tip(dir) }, "run-1");
  commit(dir, "c.txt", "c\n");
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
});

test("a deleted branch runs in full, with no throw", (t) => {
  const dir = repo(t);
  recordHead(dir, "5", { branch: "agent/issue-5", green: tip(dir) }, "run-1");
  git(dir, "checkout", "-q", "main");
  git(dir, "branch", "-D", "agent/issue-5");
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
});

test("a branch already merged into base runs in full", (t) => {
  const dir = repo(t);
  recordHead(dir, "5", { branch: "agent/issue-5", green: tip(dir) }, "run-1");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--ff-only", "agent/issue-5");
  assert.equal(landOnlyHead(dir, "main", "5"), undefined);
});

test("the resolver prompt is rendered with the others, with every kit placeholder filled", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-landonly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project: Project = {
    root,
    name: "land-only-test",
    baseBranch: "main",
    label: "ready-for-agent",
    concurrency: 1,
    mounts: [],
    setup: [],
    lean: { keep: [], dropHooks: [] },
    gates: [{ name: "unit", command: "echo gate-ok" }],
    hookTests: [],
    land: "merge",
    generated: [],
    implement: {},
    review: {},
    repair: {},
    tracker: { kind: "github", held: "ready-for-human", triage: "needs-triage", dir: "", done: [], source: "default" },
  };
  const { resolve } = renderPrompts(project, makeTracker(project));
  assert.equal(resolve, join(root, ".sandcastle/.run", "resolve.md"));
  assert.ok(existsSync(resolve));
  const text = readFileSync(resolve, "utf8");
  for (const want of ["git diff --name-only --diff-filter=U", "git commit --no-edit", "echo gate-ok", "<promise>COMPLETE</promise>"]) {
    assert.ok(text.includes(want), `missing ${want}`);
  }
  assert.ok(!text.includes("{{KIT_"));
});
