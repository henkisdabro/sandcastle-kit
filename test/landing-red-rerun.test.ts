// A red landing gate is run once more before the ticket is requeued, as a ticket's gates are, and a red whose
// failing tests the branch's own ticket gates already failed in this run names no landed ticket. Temp repos, a fake
// tracker and a host worktree for the sandbox, as test/landing-requeue-red.test.ts has: no Docker, no gh, no network.
//
//   pnpm test:file test/landing-red-rerun.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne, rememberFailed, requeuedLine, againLine, redNote } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { quietly } = await import("./quiet.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;
type Landed = import("../src/landing.ts").Landed;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-red-rerun-"));
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

const redOn = (name: string, ...tests: string[]): GateRun => {
  const failure = { name, command: name, exitCode: 1, output: tests.map((t) => `FAIL ${t}`).join("\n") };
  return { gates: [{ name: "lint", pass: true }, { name, pass: false }], failure, failures: [failure] };
};
const GREEN: GateRun = { gates: [{ name: "lint", pass: true }, { name: "test", pass: true }], failures: [] };

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
  return { land, calls };
};

test("a red landing gate is run again from the red gate before the ticket is red, and a flake lands", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const { land, calls } = harness(root, [redOn("test", "a.test.ts"), GREEN]);
  assert.equal((await landSecond(land)).kind, "merged");
  assert.deepEqual(calls, [{ rerunOnRed: true }, { from: "test" }]);
});

test("a landing gate red again on the re-run is red, with the re-run's failure and the whole gate list", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const { land, calls } = harness(root, [redOn("test", "a.test.ts"), redOn("test", "b.test.ts")]);
  const landed = await landSecond(land);
  assert.equal(calls.length, 2);
  assert.equal(landed.kind, "red");
  assert.deepEqual(landed.kind === "red" && landed.failing, ["b.test.ts"]);
  assert.deepEqual(landed.kind === "red" && landed.gates, ["test"]);
});

test("a port that ran the re-run inside its own slot is not asked for another", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const first = redOn("test", "a.test.ts");
  const { land, calls } = harness(root, [{ ...redOn("test", "a.test.ts"), rerunOf: first }]);
  assert.equal((await landSecond(land)).kind, "red");
  assert.equal(calls.length, 1);
});

test("a timed-out landing gate is not run again", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const red = redOn("test", "a.test.ts");
  red.failure!.exitCode = 124;
  const { land, calls } = harness(root, [red]);
  assert.equal((await landSecond(land)).kind, "red");
  assert.equal(calls.length, 1);
});

test("a green landing gate is run once", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const { land, calls } = harness(root, [GREEN]);
  assert.equal((await landSecond(land)).kind, "merged");
  assert.deepEqual(calls, [{ rerunOnRed: true }]);
});

test("a red whose failing tests the branch's own gates failed names no landed ticket and says it was seen before", async () => {
  const root = makeRepo({ 1: { "t.test.ts": "one\n" }, 2: { "t.test.ts": "one\n", "b.txt": "b\n" } });
  // Both branches add t.test.ts with the same text: git merges that cleanly, and the landed ticket changed a file the branch did.
  const red = redOn("test", "t.test.ts");
  const failedBefore = new Map([["2", new Set(["t.test.ts"])]]);
  const { land } = harness(root, [red, red], failedBefore);
  assert.equal((await land("1")).kind, "merged");
  const landed = await land("2");
  assert.equal(landed.kind, "red");
  assert.deepEqual(landed.kind === "red" && landed.with, []);
  assert.equal(landed.kind === "red" && landed.seen, true);
  assert.equal(requeuedLine("red", [], { gates: ["test"], failing: ["t.test.ts"], seen: true }), "requeued after red as seen on the branch before (gate test; failing t.test.ts)");
  assert.equal(againLine("red", [], { seen: true }), "red again as seen on the branch before after a requeue");
  assert.equal(redNote({ with: [], gates: ["test"], seen: true }), "red as seen on the branch before (gate test)");
});

test("a red with a failing test the branch's own gates did not fail still names the landed ticket", async () => {
  const root = makeRepo({ 1: { "t.test.ts": "one\n" }, 2: { "t.test.ts": "one\n", "b.txt": "b\n" } });
  const red = redOn("test", "t.test.ts", "other.test.ts");
  const failedBefore = new Map([["2", new Set(["t.test.ts"])]]);
  const { land } = harness(root, [red, red], failedBefore);
  await land("1");
  const landed = await land("2");
  assert.equal(landed.kind, "red");
  assert.deepEqual(landed.kind === "red" && landed.with, ["1"]);
  assert.equal(landed.kind === "red" && landed.seen, undefined);
});

test("a ticket whose own gates failed other tests, or none, is not 'seen before'", async () => {
  const root = makeRepo({ 1: { "t.test.ts": "one\n" }, 2: { "t.test.ts": "one\n", "b.txt": "b\n" } });
  const red = redOn("test", "t.test.ts");
  const { land } = harness(root, [red, red], new Map([["3", new Set(["t.test.ts"])]]));
  await land("1");
  const landed = await land("2");
  assert.equal(landed.kind === "red" && landed.seen, undefined);
  assert.deepEqual(landed.kind === "red" && landed.with, ["1"]);
});

test("the tests a ticket gate run failed are kept, a re-run's green flake included", () => {
  const kept = new Map<string, Set<string>>();
  const first = redOn("test", "a.test.ts", "b.test.ts");
  const run: GateRun = { ...GREEN, rerunOf: first };
  assert.equal(rememberFailed(kept, "7", run), run, "the run is handed on as it came");
  rememberFailed(kept, "7", redOn("test", "c.test.ts"));
  rememberFailed(kept, "8", redOn("lint"));
  assert.deepEqual([...kept.get("7")!].sort(), ["a.test.ts", "b.test.ts", "c.test.ts"]);
  assert.equal(kept.has("8"), false);
});

test("burndown hands the landing gate its re-run and keeps what the ticket gates failed", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /runGates\(box, id, "landing gate", true, how\?\.from, how\?\.rerunOnRed\)/);
  // A requeued ticket's gates run on the merged tree: what they fail is not the branch's own.
  assert.match(source, /if \(!priority && !ledger\.requeuedAs\.has\(id\)\) rememberFailed\(failedBefore, id, gated\);/);
  assert.match(source, /^    failedBefore,$/m);
});

test("the requeue the schedule tells, the outcome and the tracker comment of a red seen before name no ticket and say so", async () => {
  const { createSchedule } = await import("../src/schedule.ts");
  const { describe } = await import("../src/ledger.ts");
  const seenRed: Landed = { kind: "red", with: [], gates: ["test"], failing: ["t.test.ts"], seen: true };
  const told: { kind: string; again?: unknown }[] = [];
  await createSchedule<{ id: string }, { issue: string }, string, string>({ tickets: [{ id: "2" }] }).run({
    workers: 1,
    attempt: async (t) => ({ kind: "green", green: { issue: t.id } }),
    land: async () => seenRed,
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  const again = told.find((c) => c.kind === "requeued")?.again as { kind: "red"; with: string[]; seen?: true };
  assert.equal(again.seen, true);
  assert.equal(requeuedLine(again.kind, again.with, again), "requeued after red as seen on the branch before (gate test; failing t.test.ts)");
  const green = { issue: "2", branch: "agent/issue-2", status: "green" as const, commits: 1, repairs: 0, head: "abc1234" };
  const said = describe({ kind: "landing", green, landed: seenRed, attempts: 1 }, { base: "main", gateNames: "test" });
  assert.equal(said.record?.note, "red as seen on the branch before (gate test; failing t.test.ts)");
  assert.equal(said.outcome?.text, "red when merged, as seen on the branch before (gate test; failing t.test.ts)");
  assert.match(said.tracker?.text ?? "", /already failing on this branch's own ticket gates in this run, so no landed ticket is named\./);
  assert.doesNotMatch(said.tracker?.text ?? "", /on the merged tree/);
});

test("the tests of all three runs of a ticket gate are kept, the first run's included", () => {
  const kept = new Map<string, Set<string>>();
  const run: GateRun = { ...GREEN, rerunOf: { ...redOn("test", "b.test.ts"), rerunOf: redOn("test", "a.test.ts") } };
  assert.equal(rememberFailed(kept, "7", run), run);
  assert.deepEqual([...kept.get("7")!].sort(), ["a.test.ts", "b.test.ts"]);
  rememberFailed(kept, "9", { ...redOn("test", "z.test.ts"), rerunOf: { ...redOn("test", "y.test.ts"), rerunOf: redOn("test", "x.test.ts") } });
  assert.deepEqual([...kept.get("9")!].sort(), ["x.test.ts", "y.test.ts", "z.test.ts"]);
});
