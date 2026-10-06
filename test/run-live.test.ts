// "Is this run live": one answer from the run record, the lock and an injected process check
// (mod/hooks/run-live.ts), and every reader of it - the closing summary, the Herdr tab bar,
// `sandcastle wait` and `stop` - on a pid that was recycled. No real process stands in for the
// run here except where a reader asks the system itself.
//
//   node --test test/run-live.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Liveness, liveness, type Probe, RUN_COMMAND } from "../mod/hooks/run-live.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather } = await import("../src/report.ts");
const { liveRuns } = await import("../src/herdr-plugin.ts");
const { commandOf } = await import("../src/live-runs.ts");
const { livePid, waitForRun } = await import("../src/detach.ts");
const { fakeTracker } = await import("./fixtures.ts");
const { kitLikeProcess } = await import("./kit-process.ts");

const KIT_LINE = `node --no-maglev --no-concurrent-sparkplug --import /kit/src/node-check.mjs /kit/${RUN_COMMAND} run 12`;
/** A process table: the command line of each pid in it, nothing for the rest. */
const table = (processes: Record<number, string>): Probe => (pid) => processes[pid];

const STARTED = "2026-10-02T01:00:00.000Z";
const ENDED = "2026-10-02T02:00:00.000Z";
const SELF = 4242;

const cases: { name: string; record?: object; lockPid?: number; processes: Record<number, string>; self?: number; want: Liveness }[] = [
  { name: "unfinished, and its pid is the kit", record: { pid: 100, startedAt: STARTED }, processes: { 100: KIT_LINE }, want: { state: "live", pid: 100 } },
  { name: "finished with an exit code: the process is not asked", record: { pid: 100, finishedAt: ENDED, exitCode: 3 }, processes: { 100: KIT_LINE }, want: { state: "finished", exitCode: 3 } },
  { name: "finished by a clean exit and an exit code of 0", record: { pid: 100, finishedAt: ENDED, exitCode: 0 }, processes: {}, want: { state: "finished", exitCode: 0 } },
  { name: "finished with no exit code written", record: { pid: 100, finishedAt: ENDED }, processes: {}, want: { state: "finished" } },
  { name: "killed: no finishedAt and no process", record: { pid: 100, startedAt: STARTED }, processes: {}, want: { state: "dead" } },
  { name: "recycled pid: a process that is not the kit", record: { pid: 100, startedAt: STARTED }, processes: { 100: "/usr/bin/sleep 600" }, want: { state: "dead" } },
  { name: "recycled pid, even when the record claims an exit code is missing", record: { pid: 100 }, processes: { 100: "vim notes.md" }, want: { state: "dead" } },
  // The probe is the one place EPERM lives: a process another user owns still has a command line, so it is judged like any other.
  { name: "EPERM: another user's process that is the kit is live", record: { pid: 100 }, processes: { 100: KIT_LINE }, want: { state: "live", pid: 100 } },
  { name: "EPERM: another user's process that is not the kit is dead", record: { pid: 100 }, processes: { 100: "/sbin/launchd" }, want: { state: "dead" } },
  { name: "the asking process itself is neither live nor dead", record: { pid: SELF }, processes: { [SELF]: KIT_LINE }, self: SELF, want: { state: "own" } },
  { name: "the asking process, once its record has finished, is finished", record: { pid: SELF, finishedAt: ENDED, exitCode: 0 }, processes: { [SELF]: KIT_LINE }, self: SELF, want: { state: "finished", exitCode: 0 } },
  { name: "another run's unfinished record is live although a self is given", record: { pid: 100 }, processes: { 100: KIT_LINE }, self: SELF, want: { state: "live", pid: 100 } },
  { name: "a detached child: its own session, the kit's entry", record: { pid: 300 }, processes: { 300: `node /kit/${RUN_COMMAND} run --dry` }, want: { state: "live", pid: 300 } },
  { name: "the lock's process is live while the record has not been written to yet (the gap)", record: { pid: 100, finishedAt: ENDED, exitCode: 0 }, lockPid: 100, processes: { 100: KIT_LINE }, want: { state: "live", pid: 100 } },
  { name: "a lock held by a recycled pid is no run", record: { pid: 100, finishedAt: ENDED, exitCode: 1 }, lockPid: 100, processes: { 100: "bash" }, want: { state: "finished", exitCode: 1 } },
  { name: "no record and no lock", processes: {}, want: { state: "dead" } },
  { name: "a record with no pid", record: { startedAt: STARTED }, processes: { 0: KIT_LINE }, want: { state: "dead" } },
  { name: "a pid that is not a pid", record: { pid: "100", startedAt: STARTED }, processes: { 100: KIT_LINE }, want: { state: "dead" } },
];

for (const c of cases) {
  test(`liveness: ${c.name}`, () => {
    assert.deepEqual(liveness({ record: c.record, lockPid: c.lockPid, self: c.self }, table(c.processes)), c.want);
  });
}

// ---------------------------------------------------------------------------
// The real process check, and the readers that ask the system.
// ---------------------------------------------------------------------------

const project = (record: object) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-run-live-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ startedAt: STARTED, ...record }));
  return root;
};
/** A project whose run record is `record`, as `gather` takes it. */
const gathered = (record: object) => {
  const root = project(record);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return gather({ name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as never);
};
/** A pid some process has had and no longer has: the number a killed run's pid comes round to. */
const goneDeadPid = () => spawnSync("true").pid!;
test("commandOf: the kit-like process shows its command line, a stranger shows its own, a gone pid shows nothing", () => {
  const kit = kitLikeProcess();
  try {
    assert.ok(commandOf(kit.pid)?.includes(RUN_COMMAND), commandOf(kit.pid));
    assert.ok(!commandOf(process.pid)?.includes(RUN_COMMAND), "the test runner is not the kit");
    assert.equal(commandOf(goneDeadPid()), undefined);
  } finally {
    kit.kill();
  }
});

test("the closing summary: a killed run whose pid is some other live process is killed, not live", async () => {
  // A live process that is not the kit: the pid a SIGKILLed run's number came round to.
  const other = spawn("sleep", ["600"], { stdio: "ignore" });
  try {
    const facts = await gathered({ pid: other.pid });
    assert.equal(facts.live, false);
    assert.equal(facts.killed, true);
  } finally {
    other.kill();
  }
});

test("the closing summary: a live kit process is live, and a finished record is finished", async () => {
  const kit = kitLikeProcess();
  try {
    const live = await gathered({ pid: kit.pid });
    assert.deepEqual([live.live, live.killed], [true, false]);
    const done = await gathered({ pid: kit.pid, finishedAt: ENDED, exitCode: 0 });
    assert.deepEqual([done.live, done.killed], [false, false]);
  } finally {
    kit.kill();
  }
});

test("the tab bar: the file of a run whose pid was recycled is removed, a live run's stays", () => {
  const kit = kitLikeProcess();
  try {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-run-live-runs-"));
    const recycled = project({ pid: process.pid, orchestrator: "recycled" });
    const live = project({ pid: kit.pid, orchestrator: "live" });
    writeFileSync(join(dir, "a"), recycled);
    writeFileSync(join(dir, "b"), live);
    assert.deepEqual(liveRuns(dir).map((r) => r.orchestrator), ["live"]);
    assert.deepEqual(readdirSync(dir), ["b"], "the recycled run's file is gone");
    assert.ok(!existsSync(join(dir, "a")));
  } finally {
    kit.kill();
  }
});

test("wait and stop: a recycled pid in the lock and the record is not a run to wait for or signal", async () => {
  const root = project({ pid: process.pid });
  writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${process.pid} token other\n`);
  assert.equal(livePid(root), undefined, "stop has nothing to signal");
  const waited = await waitForRun(root, 0.2, 20);
  assert.deepEqual(waited, { ended: true }, "wait does not block on an unrelated process");
});

test("wait: a live run is waited for, and its end ends the wait", async () => {
  const kit = kitLikeProcess();
  const root = project({ pid: kit.pid });
  try {
    assert.deepEqual(await waitForRun(root, 0.1, 20), { ended: false, pid: kit.pid });
  } finally {
    kit.kill();
  }
});
