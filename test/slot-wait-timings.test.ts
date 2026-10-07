// A ticket's wait for a machine-wide sandbox slot comes before its `setup` step begins, so it was in no
// timings line and in no figure of the closing summary. It is the `waitMs` of the step that waited (as a
// gates-slot wait is), and a wait of a few minutes is named in the summary's per-ticket line. Temp repo
// only; no Docker, model or network.
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
const { createPipeline, takeStartSlot, ticketTime } = await import("../src/burndown.ts");
const { stepTimes, withQueued } = await import("../src/gates.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;

const root = mkdtempSync(join(tmpdir(), "sandcastle-slot-wait-"));
after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");

const MIN = 60_000;

/** A pipeline whose sandbox cannot open: what its first `setup` step was handed is all that is read. */
const firstSetup = async (slotWaitMs: number | undefined) => {
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
  await quietly(() => pipeline({ id: "7", title: "seven", body: "" } as Parameters<typeof pipeline>[0], { juncture: async () => {}, slotWaitMs })).catch((e: unknown) => assert.match(String(e), /no sandbox in this test/));
  return steps;
};

/** A machine-wide pool on a fake clock: each ask for a slot takes the next wait in `waits`, and a null wait ends in a pause (no slot). */
const fakePool = (waits: (number | null)[], parkedMs = 0) => {
  let clock = 0;
  const asks = [...waits];
  return {
    now: () => clock,
    take: async () => {
      const w = asks.shift();
      clock += w ?? 5 * MIN;
      return w !== null;
    },
    park: async () => {
      clock += parkedMs;
    },
  };
};

test("an attempt's start counts the time a fake pool held its slot back", async () => {
  const pool = fakePool([2 * 60 * MIN]);
  assert.equal(await takeStartSlot(pool.take, pool.park, pool.now), 2 * 60 * MIN);
  const free = fakePool([0]);
  assert.equal(await takeStartSlot(free.take, free.park, free.now), 0);
});

test("a pause that ended a wait for a slot leaves its time parked out of the slot wait, and the waits on either side in", async () => {
  // 5 min of waiting, a pause of an hour, then 10 more min before the slot came.
  const pool = fakePool([null, 10 * MIN], 60 * MIN);
  assert.equal(await takeStartSlot(pool.take, pool.park, pool.now), 15 * MIN);
});

test("the attempt hands its start's slot wait to the pipeline and to the summary line", () => {
  // burndown() needs Docker, so no test drives it: its wiring of the helpers tested here is held by its source.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /const slotWaitMs = await takeStartSlot\(take, /);
  assert.match(src, /slotWaited\.set\(issue\.id, \(slotWaited\.get\(issue\.id\) \?\? 0\) \+ slotWaitMs\)/);
  assert.match(src, /pipeline\(issue, \{ juncture: [^\n]*, slotWaitMs \}\)/);
  assert.match(src, /times = withQueued\(times, queuedMs\)/);
  assert.match(src, /const time = ticketTime\(took\.get\(o\.issue\), slotWaited\.get\(o\.issue\)\)/);
});

test("the attempt's wait for its sandbox slot reaches the setup step, the first step of the ticket", async () => {
  assert.deepEqual(await firstSetup(2 * 60 * MIN), [{ phase: "setup", queuedMs: 2 * 60 * MIN }]);
});

test("a ticket that waited for no slot hands its setup step no wait", async () => {
  assert.deepEqual(await firstSetup(undefined), [{ phase: "setup", queuedMs: undefined }]);
});

test("a slot wait is the setup line's waitMs, apart from its own ms and from a wait inside the step", () => {
  // A two-hour wait, then a setup that took 8 s: 8 s of work, 2 h of wait.
  assert.deepEqual(withQueued(stepTimes(8_000, {}), 2 * 60 * MIN), { ms: 8_000, waitMs: 2 * 60 * MIN });
  // A wait inside the step (a gates slot, the plan's limit) and one before it add up, `ms` leaving both out.
  assert.deepEqual(withQueued(stepTimes(10_000, { waitMs: 4_000 }), 1_000), { ms: 6_000, waitMs: 5_000 });
  // No wait, no field: the line is as it was.
  assert.deepEqual(withQueued(stepTimes(8_000, {}), 0), { ms: 8_000 });
  assert.deepEqual(withQueued(stepTimes(8_000, {}), undefined), { ms: 8_000 });
});

test("the summary's per-ticket line names a slot wait of a few minutes or more, and keeps the ticket's own time", () => {
  assert.equal(ticketTime(8 * MIN, 2 * 60 * MIN), " 8m, waited 2h for a slot");
  assert.equal(ticketTime(8 * MIN, 135 * MIN), " 8m, waited 2h15m for a slot");
  assert.equal(ticketTime(8 * MIN, 12 * MIN), " 8m, waited 12m for a slot");
  assert.equal(ticketTime(8 * MIN, 3 * MIN), " 8m, waited 3m for a slot");
  assert.equal(ticketTime(45_000, 10 * MIN), " 45s, waited 10m for a slot");
});

test("the summary's per-ticket line is as before for a short wait or none", () => {
  assert.equal(ticketTime(8 * MIN, 2 * MIN), " 8m");
  assert.equal(ticketTime(8 * MIN, undefined), " 8m");
  assert.equal(ticketTime(undefined, undefined), "");
});
