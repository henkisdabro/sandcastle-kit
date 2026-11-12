// A ticket gate that goes green takes the run's landing claim before its gates slot frees (#903): between the slot's release
// and the branch's push to the landing queue (the ticket's sandbox closes first), the next ticket's gate took the slot, the green
// ticket landed while it ran, and the next merge was stale again. `RunClaim.greenGate(id)` is called inside the slot; `pushed(id)`
// turns the want into the queued one and `greenDropped(id)` ends it for an attempt that never pushes. Gates limit 1, through
// test/pool-sim.ts; the scheduler's drop is checked through `createSchedule` with a fake claim.
//
//   pnpm test:file test/pool-claim-green-gate.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { cleanup, pool, POLL, slots, steady, until } from "./pool-sim.ts";

const { createRunClaim, withSlot } = pool;
const { createSchedule } = await import("../src/schedule.ts");
const { runGates } = await import("../src/gates.ts");
type Landed = import("../src/landing.ts").Landed;
type Attempted = import("../src/schedule.ts").Attempted<{ issue: string }, string>;

const finish: (() => void)[] = [];
afterEach(async () => {
  for (const f of finish.splice(0)) f();
  await cleanup();
});

const gateway = () => {
  let open!: () => void;
  const done = new Promise<void>((r) => (open = r));
  finish.push(open);
  return { done, open };
};

/** A ticket gate of the run, holding the slot until `open()`; with `green` it tells the claim `greenGate(id)` inside the slot, as `runGates` does. */
const ticketGate = (log: string[], name: string, claim?: ReturnType<typeof createRunClaim>, green?: string[]) => {
  const hold = gateway();
  const t = { held: false, open: hold.open, done: undefined as unknown as Promise<void> };
  t.done = withSlot("gates", name, async () => {
    t.held = true;
    log.push(name);
    await hold.done;
    for (const id of green ?? []) claim?.greenGate(id);
  }, undefined, POLL);
  return t;
};

/** The claim bound to a landing queue of `waiting` greens and a stop flag the test sets. */
const bound = () => {
  const claim = createRunClaim("gates");
  const state = { waiting: 0, stopped: false };
  claim.bind({ waiting: () => state.waiting, stopped: () => state.stopped });
  return { claim, state };
};

test("a green ticket gate leaves its freed slot to the landing, not to the ticket gate already waiting", async () => {
  const log: string[] = [];
  const { claim, state } = bound();
  const a = ticketGate(log, "A", claim, ["A"]);
  await until(() => a.held, "ticket A's gates");
  const b = ticketGate(log, "B");
  a.open();
  await a.done;
  await steady(() => !b.held, "the waiting ticket gate left the slot A freed to A's landing", 60);
  // A's branch is pushed, the landing starts and its priority wait spends the claim handed through take().
  state.waiting = 1;
  claim.pushed("A");
  state.waiting = 0;
  claim.started();
  const handed = claim.take();
  const gate = gateway();
  const landing = withSlot("gates", "landing A", async () => {
    log.push("landing A");
    await gate.done;
  }, undefined, POLL, true, false, undefined, handed);
  await until(() => log.includes("landing A"), "A's landing gates");
  assert.equal(b.held, false);
  gate.open();
  await landing;
  handed?.release();
  claim.gateEnded();
  // The landing's gate is over but the landing is not: nothing is queued, so B may take the slot once the landing ends.
  claim.ended();
  await until(() => b.held, "the second ticket gate's slot, once the landing ended with nothing queued");
  assert.deepEqual(log, ["A", "landing A", "B"]);
  b.open();
  await b.done;
});

test("a green gate dropped with nothing queued frees the claim: the waiting ticket gate takes the slot", async () => {
  const log: string[] = [];
  const { claim } = bound();
  const a = ticketGate(log, "A", claim, ["A"]);
  await until(() => a.held, "ticket A's gates");
  const b = ticketGate(log, "B");
  a.open();
  await a.done;
  await steady(() => !b.held, "B waited behind A's pending green", 60);
  claim.greenDropped("A");
  await until(() => b.held, "B's slot, once A's attempt ended without a push");
  b.open();
  await b.done;
});

test("two pending greens, one dropped: the claim stands for the other", async () => {
  const log: string[] = [];
  const { claim } = bound();
  claim.greenGate("A");
  claim.greenGate("B");
  const waiting = ticketGate(log, "C");
  await steady(() => !waiting.held, "C waited behind the pending greens", 60);
  claim.greenDropped("A");
  await steady(() => !waiting.held, "B's want still stands after A's drop", 60);
  claim.greenDropped("B");
  await until(() => waiting.held, "C's slot, once both were dropped");
  waiting.open();
  await waiting.done;
});

test("one attempt going green twice is one want: a single push settles it, and the waiting ticket gate then takes the slot", async () => {
  const log: string[] = [];
  const { claim, state } = bound();
  claim.greenGate("A");
  claim.greenGate("A");
  state.waiting = 1;
  claim.pushed("A");
  state.waiting = 0;
  claim.started();
  claim.take()?.release();
  claim.gateEnded();
  claim.ended();
  const b = ticketGate(log, "B");
  await until(() => b.held, "B's slot: a second green gate of A left no want behind");
  b.open();
  await b.done;
});

test("a push with no gate run (a land-only branch) leaves another ticket's pending want standing", async () => {
  const log: string[] = [];
  const { claim, state } = bound();
  claim.greenGate("A");
  state.waiting = 1;
  claim.pushed("B");
  state.waiting = 0;
  claim.started();
  claim.take()?.release();
  claim.gateEnded();
  claim.ended();
  const c = ticketGate(log, "C");
  await steady(() => !c.held, "A's want kept the claim after B's push", 60);
  claim.greenDropped("A");
  await until(() => c.held, "C's slot, once A's want was dropped");
  c.open();
  await c.done;
});

test("a stop releases a pending green's claim", async () => {
  const log: string[] = [];
  const { claim, state } = bound();
  claim.greenGate("A");
  const waiting = ticketGate(log, "B");
  await steady(() => !waiting.held, "B waited behind A's pending green", 60);
  state.stopped = true;
  claim.settle();
  await until(() => waiting.held, "B's slot, once the stop released the claim");
  waiting.open();
  await waiting.done;
});

// The scheduler: every attempt that ends without a push tells the claim to drop its want; the push comes first for a green one.
test("the scheduler drops a green gate's want for every attempt that ends without a push", async () => {
  const events: string[] = [];
  const claim = {
    bind: () => {},
    pushed: (id?: string) => void events.push(`pushed ${id}`),
    greenGate: (id: string) => void events.push(`green ${id}`),
    greenDropped: (id: string) => void events.push(`dropped ${id}`),
    started: () => {},
    ended: () => {},
    settle: () => {},
  };
  const slot = async (wanted: () => boolean) => (wanted() ? { release: () => {} } : undefined);
  const { endings } = await createSchedule<{ id: string }, { issue: string }, string>({ tickets: ["P", "R", "X"].map((id) => ({ id })) }).run({
    workers: 1,
    concurrency: 1,
    slot,
    claim,
    land: async () => ({ kind: "merged" }) as unknown as Landed,
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
    attempt: async (t): Promise<Attempted> => {
      // The pipeline's gate port tells the claim `greenGate` inside the gates slot; the attempt then ends as the ticket says.
      claim.greenGate(t.id);
      if (t.id === "P") return { kind: "green", green: { issue: t.id } };
      if (t.id === "R") return { kind: "pipeline", outcome: "red after a later step" };
      return { kind: "crashed", error: new Error("the sandbox died") };
    },
  });
  assert.equal(endings.get("P")?.kind, "landing");
  assert.ok(events.indexOf("pushed P") >= 0 && events.indexOf("pushed P") < events.indexOf("dropped P"), "P's push comes before its (empty) drop");
  assert.ok(events.includes("dropped R"), "a red ending after a green gate drops the want");
  assert.ok(events.includes("dropped X"), "a crash after a green gate drops the want");
});

// runGates itself, over a made-up sandbox: the callback fires while the run still holds its gates slot file.
const project = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }, { name: "unit", command: "run-unit" }] } as Parameters<typeof runGates>[0];
const sandbox = (red?: string) => ({ exec: async (cmd: string) => ({ exitCode: red && cmd.includes(red) ? 1 : 0, stdout: "", stderr: "" }) });
const gatesSlotsHeld = () => readdirSync(slots).filter((f) => /^gates-\d+\.lock$/.test(f)).length;

test("a green ticket gate run tells the claim once, with its gates slot still held", async () => {
  const held: number[] = [];
  const run = await runGates(project, sandbox(), "fixture gates", false, { green: () => held.push(gatesSlotsHeld()) });
  assert.equal(run.failure, undefined);
  assert.deepEqual(held, [1]);
  assert.equal(gatesSlotsHeld(), 0);
});

test("a red ticket gate run, a landing's priority run and a run the caller stopped tell the claim nothing", async () => {
  const told: string[] = [];
  const green = () => void told.push("green");
  await runGates(project, sandbox("run-unit"), "fixture gates", false, { green });
  await runGates(project, sandbox(), "fixture landing gates", false, { green }, true);
  await runGates(project, sandbox(), "fixture gates", false, { green, onSlot: () => false });
  assert.deepEqual(told, []);
});

test("a ticket gate run that goes red and then green on its re-run in the same slot tells the claim once", async () => {
  let reds = 1;
  const flaky = { exec: async (cmd: string) => ({ exitCode: cmd.includes("run-unit") && reds-- > 0 ? 1 : 0, stdout: "", stderr: "" }) };
  const told: number[] = [];
  const run = await runGates(project, flaky, "fixture gates", false, { green: () => told.push(gatesSlotsHeld()) }, false, undefined, true);
  assert.equal(run.failure, undefined);
  assert.deepEqual(told, [1]);
});

test("runGates calls the green callback inside its slot, only for a ticket's green run (source)", () => {
  const src = readFileSync(new URL("../src/gates.ts", import.meta.url), "utf8");
  // `done` wraps each result the slot's function returns; it tells only when the run is a ticket's (`!priority`) and has no failure.
  assert.match(src, /const done = \(run: GateRun\): GateRun => \{\s*if \(!priority && !run\.failure && !run\.failures\.length\) progress\.green\?\.\(\);/);
  const inside = src.slice(src.indexOf('return await withSlot("gates", label'));
  assert.equal([...inside.matchAll(/return done\(/g)].length, 3, "each way a gate run ends green returns through done()");
  assert.match(inside, /go === false\) \{[^}]*return \{ gates: \[\], failures: \[\]/, "a run the caller stopped returns without done()");
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(burndown, /green: \(\) => landingPorts\.claim\?\.greenGate\(id\),/);
});
