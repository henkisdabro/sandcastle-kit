// Autonomy levels (src/autonomy.ts): the level from env and config, which tickets are
// re-runnable, the turn decision, the level-1 question, several run records and one run lock in
// a single process, and the CLI refusing a bad level before any spend.
//
//   pnpm exec tsx --test test/autonomy.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { OutcomeEntry, RunRecord } from "../mod/hooks/run-record.ts";
import { runKit } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { autonomyLevel, capLine, conflictedIn, confirm, DRAIN_CAP, drainLine, drainStop, nextTurn, noRerunCause, rerunList, rerunnable } = await import("../src/autonomy.ts");
const { recordRun } = await import("../src/run.ts");
const { lockRun } = await import("../src/guard.ts");
const { OperatorError } = await import("../src/errors.ts");
const { refOf } = await import("../src/tracker.ts");
type Facts = Parameters<typeof rerunnable>[0];
type Project = Parameters<typeof recordRun>[0];


test("autonomyLevel: the env wins over config, unset is 0", () => {
  assert.equal(autonomyLevel(undefined, undefined), 0);
  assert.equal(autonomyLevel("", undefined), 0);
  assert.equal(autonomyLevel(undefined, 3), 3);
  assert.equal(autonomyLevel("2", 1), 2);
  assert.equal(autonomyLevel("0", 3), 0);
  assert.equal(autonomyLevel(" 1 ", undefined), 1);
});

test("autonomyLevel: drain, from env or config", () => {
  assert.equal(autonomyLevel("drain", undefined), "drain");
  assert.equal(autonomyLevel(" drain ", 1), "drain");
  assert.equal(autonomyLevel(undefined, "drain"), "drain");
  assert.equal(autonomyLevel("0", "drain"), 0);
});

test("autonomyLevel: anything but 0-3 or drain is an OperatorError", () => {
  for (const bad of ["4", "x", "1.5", "forever", "Drain"]) {
    assert.throws(
      () => autonomyLevel(bad, undefined),
      (e: Error) => e instanceof OperatorError && e.message.includes("AUTONOMY_LEVEL=") && e.message.includes("expected 0, 1, 2, 3 or drain"),
    );
  }
  assert.throws(
    () => autonomyLevel(undefined, 5),
    (e: Error) => e instanceof OperatorError && e.message.includes("autonomy: 5 in .sandcastle/config.ts"),
  );
  assert.throws(() => autonomyLevel(undefined, "forever"), (e: Error) => e instanceof OperatorError && e.message.includes("autonomy: forever in .sandcastle/config.ts"));
});

const facts: Facts = {
  base: "main",
  tracker: "github",
  started: "2026-01-01T00:00:00Z",
  live: false,
  dryRun: false,
  verify: { green: true, line: "" },
  gateCount: 1,
  tickets: { 1: { state: "conflict" }, 2: { state: "merged" }, 3: { state: "blocked" }, 4: { state: "red" } } satisfies RunRecord["tickets"],
  runnable: ["3"],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
};

test("rerunnable: conflicted and newly unblocked tickets, never after a dry, stopped, red or skipped run", () => {
  assert.deepEqual(rerunnable(facts), { conflicted: ["1"], unblocked: ["3"] });
  assert.equal(rerunnable({ ...facts, dryRun: true }), undefined);
  assert.equal(rerunnable({ ...facts, stopped: "usage limit" }), undefined);
  assert.equal(rerunnable({ ...facts, verify: { green: false, line: "" } }), undefined);
  assert.equal(rerunnable({ ...facts, tickets: { ...facts.tickets, 5: { state: "skipped" } } }), undefined);
  assert.deepEqual(rerunnable({ ...facts, verify: null }), { conflicted: ["1"], unblocked: ["3"] });
});

test("nextTurn: the level caps the turns, level 1 always asks", () => {
  const r = { conflicted: ["1"], unblocked: [] };
  assert.equal(nextTurn(0, 1, r), "stop");
  assert.equal(nextTurn(1, 1, r), "ask");
  assert.equal(nextTurn(1, 7, r), "ask");
  assert.equal(nextTurn(2, 1, r), "run");
  assert.equal(nextTurn(2, 2, r), "cap");
  assert.equal(nextTurn(3, 2, r), "run");
  assert.equal(nextTurn(3, 3, r), "cap");
  assert.equal(nextTurn(3, 1, undefined), "stop");
  assert.equal(nextTurn(3, 1, { conflicted: [], unblocked: [] }), "stop");
});

test("nextTurn: drain runs while there is work, up to the cap", () => {
  const r = { conflicted: [], unblocked: ["3"] };
  assert.equal(nextTurn("drain", 1, r), "run");
  assert.equal(nextTurn("drain", DRAIN_CAP - 1, r), "run");
  assert.equal(nextTurn("drain", DRAIN_CAP, r), "cap");
  assert.equal(DRAIN_CAP, 20);
  assert.equal(nextTurn("drain", 1, undefined), "stop");
  assert.equal(nextTurn("drain", 1, { conflicted: [], unblocked: [] }), "stop");
  assert.match(capLine("drain", ["3"], "#3"), /^Autonomy level drain: 20 turn\(s\) done, the cap; 1 ticket\(s\) can still run again/);
  assert.match(capLine(2, ["3"], "#3"), /^Autonomy level 2: 2 turn\(s\) done/);
});

test("noRerunCause: names why a turn is not followed, and is silent when one may be", () => {
  assert.equal(noRerunCause(facts), undefined);
  assert.match(noRerunCause({ ...facts, dryRun: true })!, /dry run/);
  assert.match(noRerunCause({ ...facts, stopped: "usage limit" })!, /usage limit/);
  assert.match(noRerunCause({ ...facts, verify: { green: false, line: "" } })!, /base is red/);
  assert.match(noRerunCause({ ...facts, tickets: { 5: { state: "skipped" } } })!, /stopped early/);
  assert.equal(
    noRerunCause({ ...facts, tickets: { 5: { state: "skipped", note: "not started: #4 hit the plan's usage limit" } } }),
    "the run stopped early (#4 hit the plan's usage limit)",
  );
});

test("drainStop: no progress, and the same ticket conflicting in two turns running", () => {
  const turn = (landed: number, released: string[] = [], conflicted: string[] = []) => ({ landed, released, conflicted });
  assert.equal(drainStop(turn(1), undefined), undefined);
  assert.equal(drainStop(turn(0, ["4"]), undefined), undefined);
  assert.equal(drainStop(turn(0, ["4"], ["1"]), turn(2, [], ["2"])), undefined);
  assert.match(drainStop(turn(0), undefined)!, /^no progress: the turn landed nothing and released nothing$/);
  assert.match(drainStop(turn(0), turn(3))!, /^no progress/);
  assert.equal(drainStop(turn(2, [], ["1", "2"]), turn(1, [], ["2", "3"]), refOf), "#2 conflicted in two turns running");
  // A conflict naming the ticket wins over the progress other tickets made.
  assert.match(drainStop(turn(5, ["9"], ["1"]), turn(1, [], ["1"]), refOf)!, /^#1 conflicted/);
});

test("conflictedIn: the tickets this run's outcomes record as a conflict, by kind", () => {
  const outcomes = {
    1: { run: "r2", kind: "conflict", text: "merge conflict: src/a.ts" },
    2: { run: "r2", kind: "merged", text: "merged" },
    3: { run: "r1", kind: "conflict", text: "merge conflict: src/b.ts" },
    4: { run: "r2", kind: "conflict", with: ["1", "3"], text: "merge conflict: conflicted again with #1, #3 after a requeue" },
    5: { run: "r2" },
    // The line is never read: one with no kind is no conflict, whatever it says.
    6: { run: "r2", text: "merge conflict: src/c.ts" },
  } satisfies Record<string, OutcomeEntry>;
  assert.deepEqual(conflictedIn(outcomes, "r2"), ["1", "4"]);
  assert.deepEqual(conflictedIn({}, "r2"), []);
});

test("drainLine: turns, landed and the cause", () => {
  assert.equal(drainLine(3, 7, "no progress"), "Drain: 3 turns, 7 landed, stopped because no progress");
  assert.equal(drainLine(1, 0, "x"), "Drain: 1 turn, 0 landed, stopped because x");
});

test("rerunList names each part, and leaves out an empty one", () => {
  assert.equal(rerunList({ conflicted: ["12"], unblocked: ["14"] }, refOf), "#12, #14 (conflicted: #12; unblocked: #14)");
  assert.equal(rerunList({ conflicted: ["12"], unblocked: [] }, refOf), "#12 (conflicted: #12)");
  assert.equal(rerunList({ conflicted: [], unblocked: ["14"] }, refOf), "#14 (unblocked: #14)");
});

test("confirm: not a terminal is undefined and reads nothing; at a terminal only y is yes", async () => {
  const quiet = new PassThrough();
  const sink = new PassThrough();
  let written = "";
  sink.on("data", (d) => (written += d));
  assert.equal(await confirm("Run? ", quiet, sink), undefined);
  assert.equal(written, "");
  for (const [typed, expected] of [["y\n", true], ["n\n", false], ["\n", false]] as const) {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    input.end(typed);
    assert.equal(await confirm("Run? ", input, new PassThrough()), expected, JSON.stringify(typed));
  }
});

test("confirm: Ctrl-C at the question is a no, not a thrown AbortError", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  const answer = confirm("Run? ", input, output);
  input.write("\u0003");
  assert.equal(await answer, false);
});

const project = (): Project => ({ root: mkdtempSync(join(tmpdir(), "sandcastle-autonomy-")), name: "t" }) as unknown as Project;

test("recordRun twice in one process: the first run is finished in history, the second is live", () => {
  const p = project();
  recordRun(p, { stage: "first" });
  recordRun(p, { stage: "second" });
  const lines = readFileSync(join(p.root, ".sandcastle/logs/history.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const first = JSON.parse(lines[0]);
  assert.equal(first.stage, "first");
  assert.ok(first.finishedAt);
  assert.equal(first.exitCode, 0);
  const live = JSON.parse(readFileSync(join(p.root, ".sandcastle/logs/run.json"), "utf8"));
  assert.equal(live.stage, "second");
  assert.equal(live.finishedAt, undefined);
});

test("lockRun held by another live process refuses with what to do", () => {
  const p = project();
  mkdirSync(join(p.root, ".sandcastle/logs"), { recursive: true });
  // This process's parent: alive for the whole test, and not this process.
  writeFileSync(join(p.root, ".sandcastle/logs/run.lock"), `${process.ppid} x t\n`);
  assert.throws(
    () => lockRun(p),
    (e: Error) => e instanceof OperatorError && /is live \(pid \d+\)\. One run per project at a time: wait for it to end \(`sandcastle status` shows it\), or stop it with Ctrl-C/.test(e.message),
  );
});

test("lockRun twice in one process does not refuse its own lock", () => {
  const p = project();
  lockRun(p);
  assert.doesNotThrow(() => lockRun(p));
});

test("the CLI refuses a bad AUTONOMY_LEVEL with a message and no stack, before any work", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-autonomy-cli-"));
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd });
  mkdirSync(join(cwd, ".sandcastle"));
  writeFileSync(join(cwd, ".sandcastle/config.ts"), 'export default { name: "t", gates: [{ name: "g", command: "true" }] };\n');
  const r = runKit(["run"], {
    cwd,
    env: { ...process.env, AUTONOMY_LEVEL: "7", XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-test-")), GIT_CEILING_DIRECTORIES: tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("AUTONOMY_LEVEL=7 - expected 0, 1, 2, 3 or drain."), r.stderr);
  assert.ok(!r.stderr.split("\n").some((l) => /^\s+at /.test(l)), r.stderr);
});
