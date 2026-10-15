// A ticket off its worker on an uncounted lock (src/burndown.ts `createGateSeat`) that claimed a failure's repair asks for a
// worker again before its repair pass (`retake`). A ticket that holds a worker and waits on the fix board for that repair
// would hold the very worker the fixer waits for: the fix board's wait ends while the ticket it waits on (or the one that
// ticket waits on) asks for a worker, and the waiter repairs on its own, as it does for a landing starved of a slot. A waiter
// off its worker holds none, and keeps waiting. Driven through the scheduler with fake work and a fake counted pool.
//
//   pnpm test:file test/fix-wait-retake.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createGateSeat, fixWaitStuck } from "../src/burndown.ts";
import type { Landed } from "../src/landing.ts";
import { type Attempted, createFixBoard, createSchedule, type Slot } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), `timed out waiting for ${what}`);
};
const within = <R>(ms: number, what: string, p: Promise<R>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms).unref())]);

/** One counted sandbox slot. */
const onePool = () => {
  let free = 1;
  return {
    free: () => free,
    slot: async (wanted: () => boolean): Promise<Slot | undefined> => {
      for (;;) {
        if (!wanted()) return undefined;
        if (free > 0) {
          free--;
          let released = false;
          return { release: () => void (released || ((released = true), free++)) };
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
};

const setup = () => {
  const seats = new Map<string, ReturnType<typeof createGateSeat>>();
  const fixes = createFixBoard(() => false, 5, undefined, fixWaitStuck(seats));
  const seatOf = (id: string, at: { gateWait(): boolean; retake(): Promise<{ slot?: Slot } | undefined> }) => {
    const seat = createGateSeat({ gateWait: at.gateWait, retake: at.retake, uncount: (lease) => (lease.release(), { release: () => {} }) });
    seats.set(id, seat);
    return seat;
  };
  return { fixes, seatOf };
};

test("a waiter that holds the worker stops waiting for a fixer that asks for a worker: the run does not deadlock", async () => {
  const order: string[] = [];
  const counted = onePool();
  const { fixes, seatOf } = setup();
  const { endings } = await within(
    3000,
    "the run",
    createSchedule<T, G, string>({ tickets: [{ id: "A" }, { id: "C" }] }).run({
      workers: 1,
      concurrency: 1,
      gateWaiters: 1,
      slot: counted.slot,
      land: async () => ({ kind: "merged" }) satisfies Landed,
      host: { check: async () => {}, failed: undefined },
      tell: (c) => fixes.told(c),
      attempt: async (t, at) => {
        const seat = seatOf(t.id, at);
        if (t.id === "A") {
          // Its gates wait for a slot: off its worker. Red, it claims the repair and asks for a worker while C holds it.
          assert.equal(seat.move(at.slot!), true);
          await until(() => order.includes("C red"), "C to go red");
          fixes.claim("unit red", "A");
          order.push("A asks");
          const taken = await seat.retake();
          order.push("A repair");
          taken?.slot?.release();
          return green(t.id);
        }
        // C found the gates slot free (no move): it holds the worker through its gates, red on the same failure.
        order.push("C red");
        await until(() => order.includes("A asks"), "A to claim and ask");
        const fixer = fixes.fixing("unit red", "C");
        assert.equal(fixer?.by, "A");
        const landed = await fixes.wait("C", fixer.by);
        order.push(landed ? "C merged A's fix" : "C repairs");
        at.slot?.release();
        return green(t.id);
      },
    }),
  );
  assert.deepEqual(order, ["C red", "A asks", "C repairs", "A repair"]);
  assert.equal(endings.get("A")?.kind, "landing");
  assert.equal(endings.get("C")?.kind, "landing");
  assert.equal(counted.free(), 1);
});

test("the wait ends along the chain: a waiter whose fixer waits on a ticket that asks for a worker stops too", async () => {
  const asking = new Set<string>();
  const off = new Set<string>();
  const seats = { get: (id: string) => ({ off: off.has(id), asking: asking.has(id) }) };
  const fixes = createFixBoard(() => false, 5, undefined, fixWaitStuck(seats));
  fixes.claim("lint red", "D");
  fixes.claim("unit red", "A");
  // A is off its worker and waits for D's fix; C holds a worker and waits for A's.
  off.add("A");
  const a = fixes.wait("A", "D");
  const c = fixes.wait("C", "A");
  asking.add("D");
  assert.equal(await within(1000, "C's wait", c), false, "C stops waiting: the worker it holds is the one D waits for");
  // A holds no worker: it keeps waiting until D ends.
  const settled = await Promise.race([a.then(() => "ended"), new Promise((resolve) => setTimeout(() => resolve("waits"), 50))]);
  assert.equal(settled, "waits");
  fixes.told({ kind: "ended", id: "D", ending: { kind: "landing", green: {}, landed: { kind: "merged" }, attempts: 1 } } as never);
  assert.equal(await a, true);
});

test("source: burndown's fix board ends a wait that holds the worker a retake needs", () => {
  // burndown() needs Docker, so no test drives it: its wiring is held by its source.
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /const fixes = createFixBoard\(\(\) => slotWanted\.n > 0, undefined, \(id\) => ctx\.landed\.get\(id\)\?\.commit, fixWaitStuck\(seats\)\);/);
  assert.match(src, /seats\.set\(issue\.id, seat\);/);
  assert.match(src, /seats\.delete\(issue\.id\);/);
});
