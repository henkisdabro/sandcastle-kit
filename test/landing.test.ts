// landOne (src/landing.ts) against temp git repos and a fake tracker: a clean merge, a conflict
// that names the other merged ticket, a protected path held, a branch that moved after its gates,
// a squash landing and a dry run. What the run record says of each is the ledger's (src/ledger.ts),
// recorded as the scheduler tells the ending. No Docker, no gh, no network.
//
//   node --test test/landing.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// landOne takes a sandbox slot from the machine-wide pool (src/pool.ts), whose directory pool.ts and
// live-runs.ts derive from this at import. Under the real cache, a live run holding every slot made
// this file wait with no bound (and show up to that run as another run asking for a share).
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { landOne, createHostGit } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { createLedger } = await import("../src/ledger.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
// main holds shared.txt; each branch is cut from that start and changes the files it is given.
const makeRepo = (branches: Record<string, Record<string, string>>) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "shared.txt", "start\n", "start");
  for (const [id, files] of Object.entries(branches)) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    for (const [file, text] of Object.entries(files)) commitFile(root, file, text, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  return root;
};

const outcome = (root: string, id: string, extra: Record<string, unknown> = {}) => ({
  issue: id,
  branch: `agent/issue-${id}`,
  status: "green",
  commits: 1,
  repairs: 0,
  head: git(root, "rev-parse", `agent/issue-${id}`),
  ...extra,
});

// The sandbox a merge that is not a fast-forward is made and gated in: a host worktree, no Docker.
// execGate wraps commands in `timeout -k n n`, which macOS lacks.
const opener = (root: string): Ctx["opener"] => async (branch) => {
  const path = join(TMP, `wt${n++}`);
  git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  return {
    worktreePath: path,
    exec: async (cmd) => {
      const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    close: async () => git(root, "worktree", "remove", "--force", path),
  };
};

// `landed` is shared by the calls of one test, as one run's landing record is.
const harness = (root: string, over: { land?: "merge" | "squash"; dryRun?: boolean; landed?: Ctx["landed"]; withdrawal?: Ctx["withdrawal"]; failClose?: boolean } = {}) => {
  const calls: string[] = [];
  const states: Record<string, { state?: string; note?: string | null }> = {};
  const tracker = {
    ref: (id: string) => `#${id}`,
    close: (id: string) => {
      if (over.failClose) throw new Error("gh is down");
      calls.push(`close ${id}`);
    },
    hold: (id: string) => void calls.push(`hold ${id}`),
  };
  const project = { root, name: "fixture", baseBranch: "main", land: over.land ?? "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: (id, fields) => void (states[id] = { ...states[id], ...fields }) },
    dryRun: over.dryRun ?? false,
    opener: opener(root),
    withdrawal: over.withdrawal ?? (() => undefined),
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [], failures: [] }),
    landed: over.landed ?? new Map(),
  };
  // landOne writes no verdict: the ledger records the ending, as burndown's `tell` hands it over.
  const ledger = createLedger({
    run: ctx.run,
    outcomes: () => {},
    view: { landed: () => {} },
    context: () => ({ base: "main", gateNames: "test" }),
    bookkeep: (_id, fn) => fn(),
    dropFirst: () => {},
    ref: tracker.ref,
    say: () => {},
  });
  const land = async (o: Parameters<typeof landOne>[1]) => {
    const landed = await landOne(ctx, o);
    ledger.record(o.issue, { kind: "landing", green: o, landed, attempts: 1 });
    return landed;
  };
  return { ctx, calls, states, land };
};

test("a clean merge lands, closes the ticket and records it", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  const { land, calls, states } = harness(root);
  const landed = await land(outcome(root, "1"));
  assert.deepEqual(landed, { kind: "merged" });
  assert.equal(git(root, "show", "main:a.txt"), "a");
  assert.equal(git(root, "log", "-1", "--format=%s"), "Merge agent/issue-1 (closes #1)");
  assert.deepEqual(calls, ["close 1"]);
  assert.equal(states["1"].state, "merged");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("a conflict names the merged ticket it collides with and leaves a clean tree", async () => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n" }, 3: { "c.txt": "c\n" } });
  const record = new Map();
  const first = harness(root, { landed: record });
  assert.equal((await first.land(outcome(root, "1"))).kind, "merged");
  // 3 merged too, but touches nothing 2 does: not named.
  const second = harness(root, { landed: record });
  assert.equal((await second.land(outcome(root, "3"))).kind, "merged");
  const third = harness(root, { landed: record });
  const landed = await third.land(outcome(root, "2"));
  assert.deepEqual(landed, { kind: "conflict", files: ["shared.txt"], with: ["1"] });
  assert.equal(third.states["2"].state, "conflict");
  assert.match(third.states["2"].note ?? "", /with #1: shared\.txt/);
  assert.deepEqual(third.calls, []);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(root, "show", "main:shared.txt"), "one");
});

test("a protected path is held for a person, not merged", async () => {
  const root = makeRepo({ 1: { ".github/workflows/ci.yml": "on: push\n" } });
  const before = git(root, "rev-parse", "main");
  const { land, calls, states } = harness(root);
  const landed = await land(outcome(root, "1"));
  assert.equal(landed.kind, "held");
  assert.ok(landed.kind === "held" && landed.paths.includes(".github/workflows/ci.yml"));
  assert.deepEqual(calls, ["hold 1"]);
  assert.equal(states["1"].state, "held");
  assert.equal(git(root, "rev-parse", "main"), before);
});

test("a branch that moved after its gates passed is skipped", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  const o = outcome(root, "1");
  git(root, "checkout", "-q", "agent/issue-1");
  commitFile(root, "late.txt", "late\n", "after the gates");
  git(root, "checkout", "-q", "main");
  const before = git(root, "rev-parse", "main");
  const { land, calls } = harness(root);
  const landed = await land(o);
  assert.deepEqual(landed, { kind: "skipped", reason: "agent/issue-1 moved after its gates passed" });
  assert.deepEqual(calls, []);
  assert.equal(git(root, "rev-parse", "main"), before);
});

test("a squash landing is one commit and says so", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n", "b.txt": "b\n" } });
  const { land, calls } = harness(root, { land: "squash" });
  const landed = await land(outcome(root, "1"));
  assert.deepEqual(landed, { kind: "merged", squashed: true });
  assert.equal(git(root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 2, "one parent");
  assert.equal(git(root, "log", "-1", "--format=%s"), "Merge agent/issue-1 (closes #1)");
  assert.deepEqual(calls, ["close 1"]);
});

test("a dry run merges nothing and writes nothing to the tracker", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { ".github/workflows/ci.yml": "x\n" } });
  const before = git(root, "rev-parse", "main");
  const { land, calls, states } = harness(root, { dryRun: true });
  assert.deepEqual((await quietly(() => land(outcome(root, "1")))).result, { kind: "dry-run" });
  assert.equal(states["1"].note, "dry run: would merge");
  const held = await land(outcome(root, "2"));
  assert.equal(held.kind, "held");
  assert.match(held.kind === "held" ? held.reason : "", /^dry run: would hold/);
  assert.deepEqual(calls, []);
  assert.equal(git(root, "rev-parse", "main"), before);
});

test("the tracker's word wins: withdrawn, taken back, and a failed close still counts as merged", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" }, 3: { "c.txt": "c\n" } });
  const gone = harness(root, { withdrawal: () => ({ held: false, reason: "ticket closed during the run" }) });
  assert.deepEqual(await gone.land(outcome(root, "1")), { kind: "withdrawn", reason: "ticket closed during the run" });
  const mine = harness(root, { withdrawal: () => ({ held: true, reason: "marked needs-human during the run" }) });
  assert.deepEqual(await mine.land(outcome(root, "2")), { kind: "taken-back" });
  const before = git(root, "rev-parse", "main");
  const broken = harness(root, { failClose: true });
  assert.deepEqual(await broken.land(outcome(root, "3")), { kind: "close-failed", error: "gh is down" });
  assert.notEqual(git(root, "rev-parse", "main"), before);
  assert.equal(broken.states["3"].note, "merged; closing the ticket failed");
  // The error is a fact landing returns: the closing summary names it.
  assert.equal((broken.states["3"] as { closeFailed?: string }).closeFailed, "gh is down");
});
