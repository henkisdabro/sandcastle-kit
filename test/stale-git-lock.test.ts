// A stale .git/index.lock or an unfinished merge in the repo: a run refuses to start on it, naming the file,
// and a landing that cannot undo its own merge stops the run with its own error instead of leaving every
// later landing to fail on it. Temp repos and a fake tracker: no Docker, no gh, no network.
//
//   pnpm test:file test/stale-git-lock.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { createHostGit, landOne, LandingStop } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { assertCleanBase } = await import("../src/run.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-stale-lock-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  writeFileSync(join(root, "shared.txt"), "start\n");
  git(root, "add", "shared.txt");
  git(root, "commit", "-q", "-m", "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  writeFileSync(join(root, "one.txt"), "1\n");
  git(root, "add", "one.txt");
  git(root, "commit", "-q", "-m", "work on 1");
  git(root, "checkout", "-q", "main");
  return root;
};
const project = (root: string) => ({ root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] }) as unknown as Project;
const lock = (root: string) => join(root, ".git", "index.lock");
const mergeHead = (root: string) => join(root, ".git", "MERGE_HEAD");

const ctxFor = (root: string): Ctx => ({
  project: project(root),
  tracker: { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {}, get: () => ({ body: "" }) } as unknown as Ctx["tracker"],
  base: "main",
  gateNames: "test",
  reports: new Map(),
  run: { ticket: () => {} },
  dryRun: false,
  opener: async () => assert.fail("a branch holding the base needs no sandbox"),
  withdrawal: () => undefined,
  host: createHostGit(project(root), gitFingerprint(project(root))),
  gate: async () => assert.fail("a fast-forward is not gated again at landing"),
  landed: new Map(),
});
const green = (root: string) => ({ issue: "1", branch: "agent/issue-1", status: "green" as const, commits: 1, repairs: 0, head: git(root, "rev-parse", "agent/issue-1") });

test("a run does not start while a zero-byte .git/index.lock is there, and names the file", () => {
  const root = makeRepo();
  assertCleanBase(project(root));
  writeFileSync(lock(root), "");
  assert.throws(
    () => assertCleanBase(project(root)),
    (e: Error) => e.message.includes("NOT STARTED") && e.message.includes(lock(root)) && /remove .*index\.lock/.test(e.message) && /no git process is running/.test(e.message),
  );
});

test("a run does not start while a merge is open, though git status prints nothing", () => {
  const root = makeRepo();
  writeFileSync(mergeHead(root), `${git(root, "rev-parse", "agent/issue-1")}\n`);
  assert.equal(git(root, "status", "--porcelain"), "", "the tree looks clean");
  assert.throws(
    () => assertCleanBase(project(root)),
    (e: Error) => e.message.includes(mergeHead(root)) && e.message.includes("git merge --abort"),
  );
});

test("a landing whose merge abort fails on a stale lock stops the run with its own error, and the next landing never starts", async () => {
  const root = makeRepo();
  writeFileSync(mergeHead(root), `${git(root, "rev-parse", "agent/issue-1")}\n`);
  writeFileSync(lock(root), "");
  const ctx = ctxFor(root);
  await assert.rejects(
    quietly(() => landOne(ctx, green(root))),
    (e: Error) =>
      e instanceof LandingStop && e.message.includes("#1") && e.message.includes(lock(root)) && e.message.includes(mergeHead(root)) && /Nothing more lands/.test(e.message),
  );
  assert.ok(existsSync(lock(root)), "the kit does not delete a lock it did not take");
});

test("a landing that fails and leaves nothing behind costs its ticket only", async () => {
  const root = makeRepo();
  // Untracked, in the way of the merge: git refuses before it starts one.
  writeFileSync(join(root, "one.txt"), "mine\n");
  const { result } = await quietly(() => landOne(ctxFor(root), green(root)));
  assert.equal(result.kind, "not-landed");
  assert.ok(!existsSync(mergeHead(root)));
});
