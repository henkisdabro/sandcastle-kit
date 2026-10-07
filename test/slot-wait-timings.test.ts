// No wait for a machine-wide sandbox slot is a ticket's: a pipeline worker leases its slot before it takes
// the head of the queue (slot first, src/schedule.ts), so a ticket's slot wait is zero by construction and
// the wait is the run's (`createSlotWaits`: the run record's `waitsForShare`, the heartbeat). A ticket's
// `setup` line carries no slot wait and the summary's per-ticket line names none; a wait before the setup
// (a resolve's, test/resolve-wait-recorded.test.ts) is still the step's `waitMs`. Temp repo only; no
// Docker, model or network.
//
//   node --test test/slot-wait-timings.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createPipeline, createSlotWaits, ticketTime } = await import("../src/burndown.ts");
const { stepTimes, withQueued } = await import("../src/gates.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;

const root = mkdtempSync(join(tmpdir(), "sandcastle-slot-wait-"));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");

const MIN = 60_000;

/** A pipeline whose sandbox cannot open: what its first `setup` step was handed is all that is read. */
const firstSetup = async () => {
  const steps: { phase: string; queuedMs: number | undefined }[] = [];
  const pipeline = createPipeline({
    project: { root, name: "fixture", baseBranch: "main", gates: [] } as unknown as Ctx["project"],
    tracker: { ref: (id: string) => `#${id}`, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-04T00:00:00.000Z",
    overrides: new Map(),
    open: async () => {
      throw new Error("no sandbox in this test");
    },
    timed: (async (_issue: string, phase: string, fn: () => unknown, _note?: string, _model?: unknown, queuedMs?: number) => {
      steps.push({ phase, queuedMs });
      return fn();
    }) as Ctx["timed"],
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  } as unknown as Ctx);
  await quietly(() => pipeline({ id: "7", title: "seven", body: "" } as Parameters<typeof pipeline>[0], { juncture: async () => {} })).catch((e: unknown) => assert.match(String(e), /no sandbox in this test/));
  return steps;
};

test("the attempt takes its worker's slot, and the summary line has the ticket's work alone", () => {
  // burndown() needs Docker, so no test drives it: its wiring is held by its source.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /slot: \(wanted\) => sandboxSlot\("next ticket", \(\) => !wanted\(\)\)/);
  assert.match(src, /let lease: SlotLease \| undefined = slot;/);
  assert.match(src, /for \(await juncture\("start", start\); !lease; await juncture\("start", start\)\) await take\(\);/);
  assert.match(src, /pipeline\(issue, \{ juncture: [^\n]*, paused, resolveWaitMs \}\)/);
  assert.match(src, /times = withQueued\(times, queuedMs\)/);
  assert.match(src, /const time = ticketTime\(took\.get\(o\.issue\)\)/);
  assert.doesNotMatch(src, /slotWaitMs/);
});

test("a ticket hands its setup step no slot wait", async () => {
  assert.deepEqual(await firstSetup(), [{ phase: "setup", queuedMs: undefined }]);
});

test("the run's slot waits: the oldest open wait is the heartbeat's, and one held back by the share is the record's until none is", () => {
  let clock = 0;
  const told: boolean[] = [];
  const waits = createSlotWaits((held) => told.push(held), () => clock);
  assert.equal(waits.since, undefined, "no wait, nothing to say");
  const worker = waits.begin();
  clock = 5 * MIN;
  const resumed = waits.begin();
  assert.equal(waits.since, 0, "the oldest wait still open");
  worker.onWait("slots");
  assert.deepEqual(told, [], "a full pool is not the run's share");
  resumed.onWait("share");
  worker.onWait("share");
  assert.deepEqual(told, [true], "told once, as the first wait is held back by the share");
  resumed.end();
  assert.deepEqual(told, [true], "another wait is still held back");
  worker.onWait("slots");
  assert.deepEqual(told, [true, false], "none is held back by the share any more");
  worker.end();
  assert.equal(waits.since, undefined);
  worker.onWait("share");
  assert.deepEqual(told, [true, false], "a wait that ended says nothing more");
});

test("a wait before the step is the setup line's waitMs, apart from its own ms and from a wait inside the step", () => {
  // A two-hour wait (a resolve's), then a setup that took 8 s: 8 s of work, 2 h of wait.
  assert.deepEqual(withQueued(stepTimes(8_000, {}), 2 * 60 * MIN), { ms: 8_000, waitMs: 2 * 60 * MIN });
  // A wait inside the step (a gates slot, the plan's limit) and one before it add up, `ms` leaving both out.
  assert.deepEqual(withQueued(stepTimes(10_000, { waitMs: 4_000 }), 1_000), { ms: 6_000, waitMs: 5_000 });
  // No wait, no field: the line is as it was.
  assert.deepEqual(withQueued(stepTimes(8_000, {}), 0), { ms: 8_000 });
  assert.deepEqual(withQueued(stepTimes(8_000, {}), undefined), { ms: 8_000 });
});

test("the summary's per-ticket line is the ticket's own time", () => {
  assert.equal(ticketTime(8 * MIN), " 8m");
  assert.equal(ticketTime(45_000), " 45s");
  assert.equal(ticketTime(undefined), "");
});
