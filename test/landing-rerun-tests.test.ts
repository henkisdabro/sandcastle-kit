// A landing red whose failure came from a gate's `rerun` command (`Failure.rerun`) is read by that run's tests, not by the
// first full run's output it keeps: the red ending's `failing` and `seen`, the files its blame is built from, and the tests
// `rememberFailed` keeps. Temp repos, a fake tracker and a host worktree for the sandbox, as test/landing-red-rerun.test.ts
// has: no Docker, no gh, no network.
//
//   pnpm test:file test/landing-rerun-tests.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne, rememberFailed } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { quietly } = await import("./quiet.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;
type Landed = import("../src/landing.ts").Landed;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-rerun-tests-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
const makeRepo = (branches: Record<string, Record<string, string>>) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "shared.txt", "start\n", "start");
  commitFile(root, "tests/a.py", "def t1(): pass\n", "tests a");
  commitFile(root, "tests/b.py", "def t2(): pass\n", "tests b");
  for (const [id, files] of Object.entries(branches)) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    for (const [file, text] of Object.entries(files)) commitFile(root, file, text, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  return root;
};
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

// The first ticket fast-forwards (its own gates were the landing's, so the port is not called); the second is merged and gated in the sandbox.
const landSecond = async (land: (id: string) => Promise<Landed>) => {
  await land("1");
  return land("2");
};

type Call = { rerunOnRed?: boolean; from?: string };
// `answers` are the gate port's results in call order; the last one repeats.
const harness = (root: string, answers: GateRun[], failedBefore?: Map<string, Set<string>>) => {
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const calls: Call[] = [];
  const ctx: Ctx = {
    project,
    tracker: { ref: (id: string) => `#${id}`, get: () => ({ body: "" }), close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "lint, test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async (_box, _id, how) => {
      calls.push({ ...how });
      return answers[Math.min(calls.length - 1, answers.length - 1)]!;
    },
    landed: new Map(),
    reds: new Map(),
    ...(failedBefore ? { failedBefore } : {}),
  };
  const land = async (id: string) =>
    (await quietly(() => landOne(ctx, { issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${id}`) }))).result;
  return { land, calls, reds: ctx.reds! };
};

// The first full run named t1 and t2; the gate's `rerun` command ran only them and went red on t2 alone.
const OUTPUT = "FAILED tests/a.py::t1\nFAILED tests/b.py::t2";
const targetedRed = (tests: string[] | undefined): GateRun => {
  const failure = { name: "test", command: "pytest", exitCode: 1, output: OUTPUT, tests: ["tests/a.py::t1", "tests/b.py::t2"], rerun: { command: "pytest 'tests/a.py::t1' 'tests/b.py::t2'", ...(tests ? { tests } : {}) } };
  return { gates: [{ name: "lint", pass: true }, { name: "test", pass: false }], failure, failures: [failure] };
};
// Ticket 1 changes tests/a.py, which the first full run's output names and the targeted run's does not.
const branches = { 1: { "tests/a.py": "def t1(): return 1\n" }, 2: { "c.txt": "c\n" } };

test("a landing red from a targeted re-run lists only the tests that run named", async () => {
  const { land } = harness(makeRepo(branches), [targetedRed(["tests/b.py::t2"])]);
  const landed = await landSecond(land);
  assert.equal(landed.kind, "red");
  assert.deepEqual(landed.kind === "red" && landed.failing, ["tests/b.py::t2"]);
});

test("a landing red is seen before when the targeted run's tests were red on the branch, whatever else the first run named", async () => {
  const run = targetedRed(["tests/b.py::t2"]);
  const seen = harness(makeRepo(branches), [run], new Map([["2", new Set(["tests/b.py::t2"])]]));
  const landed = await landSecond(seen.land);
  assert.equal(landed.kind === "red" && landed.seen, true);
  // The first run's t1 was never red on the branch, but only the targeted run's tests are read.
  const onlyT1 = harness(makeRepo(branches), [run], new Map([["2", new Set(["tests/a.py::t1"])]]));
  const other = await landSecond(onlyT1.land);
  assert.equal(other.kind === "red" && other.seen, undefined);
});

test("a landing red blames the landed tickets of the targeted run's test files, not of the first run's", async () => {
  const { land } = harness(makeRepo(branches), [targetedRed(["tests/b.py::t2"])]);
  const landed = await landSecond(land);
  assert.deepEqual(landed.kind === "red" && landed.with, []);
  // The same red from the first full run alone blames ticket 1, whose change is in tests/a.py.
  const full = targetedRed(["tests/b.py::t2"]);
  delete full.failure!.rerun;
  full.failures = [full.failure!];
  const plain = harness(makeRepo(branches), [full]);
  const blamed = await landSecond(plain.land);
  assert.deepEqual(blamed.kind === "red" && blamed.with, ["1"]);
});

test("rememberFailed keeps the targeted run's tests for a chain link, not the first run's", () => {
  const kept = new Map<string, Set<string>>();
  rememberFailed(kept, "7", targetedRed(["tests/b.py::t2"]));
  assert.deepEqual([...(kept.get("7") ?? [])], ["tests/b.py::t2"]);
});
