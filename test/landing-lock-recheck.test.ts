// A landing whose merge fails on an `index.lock` looks again after a short wait before it stops every landing: a
// lock another git process held for a moment is gone by then and costs that ticket only. A lock that stays still
// stops the run. Temp repos and a fake tracker: no Docker, no gh, no network.
//
//   pnpm test:file test/landing-lock-recheck.test.ts

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
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-lock-recheck-"));
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

const ctxFor = (root: string, lockRecheckMs: number): Ctx => ({
  lockRecheckMs,
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


test("a lock that is gone after a short wait costs the landing's ticket only, not the run", async () => {
  const root = makeRepo();
  writeFileSync(lock(root), "");
  setTimeout(() => rmSync(lock(root), { force: true }), 300);
  const { result } = await quietly(() => landOne(ctxFor(root, 200), green(root)));
  assert.equal(result.kind, "not-landed");
  assert.ok(!existsSync(lock(root)));
});

test("a lock that stays stops the run after the re-checks, naming the file", async () => {
  const root = makeRepo();
  writeFileSync(lock(root), "");
  const started = Date.now();
  await assert.rejects(
    quietly(() => landOne(ctxFor(root, 100), green(root))),
    (e: Error) => e instanceof LandingStop && e.message.includes(lock(root)) && /Nothing more lands/.test(e.message),
  );
  assert.ok(Date.now() - started >= 250, "it looked again, three times, before it stopped");
  assert.ok(existsSync(lock(root)), "the kit does not delete a lock it did not take");
});
