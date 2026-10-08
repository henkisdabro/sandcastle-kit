// Slot first (createSchedule in src/schedule.ts): a pipeline worker leases its machine-wide sandbox slot
// (`Work.slot`) and only then takes the head of the start queue, so a ticket's rank decides when a slot is
// granted. A worker that took its ticket first and then waited for a slot parked every worker on a later
// ticket, and a ticket released or requeued "to start at the next free slot" waited out each of their
// pipelines. Two workers for one free slot, as a run with a share of 1 beside another project's run has;
// the slots are the real pool's (src/pool.ts) in a temp cache, the other run is files (test/pool-sim.ts).
// Fake attempts and landings; no git, no Docker, no network.
//
//   pnpm test:file test/schedule-slot-first.test.ts

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, end, mine, other, POLL, pool, slots, steady, until } from "./pool-sim.ts";

const { createSchedule } = await import("../src/schedule.ts");
type Change = import("../src/schedule.ts").Change<G, string, string>;
type Landed = import("../src/landing.ts").Landed;
type T = { id: string };
type G = { issue: string };

afterEach(cleanup);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const CONFLICT: Landed = { kind: "conflict", files: ["shared.txt"], with: ["9"] };
const waitEntries = () => (existsSync(join(slots, "waits")) ? readdirSync(join(slots, "waits")).filter((f) => f.endsWith(".wait")) : []);

/** The other project's run holds 5 of the 6 slots: this run has one, and two workers. */
const oneFreeSlot = () => other("beta", { demand: 6, held: 5 });

/**
 * Two workers, the pool's slots. `ids` start in order and `dependants` (id -> its one blocker) are released
 * as the blocker lands; `conflicts` conflict on their first landing. The first attempt of `slow` holds its
 * slot until `ready` says everything it waits to see has been told. Each attempt records whether the
 * scheduler handed it a slot: the slot port is the only way one is taken.
 */
const play = async (o: { ids: string[]; dependants?: Record<string, string>; slow: string; conflicts?: string[]; ready: (told: Change[]) => boolean }) => {
  const dependants = o.dependants ?? {};
  const told: Change[] = [];
  const attempts: string[] = [];
  const handed: boolean[] = [];
  const landedOnce = new Set<string>();
  const schedule = createSchedule<T, G, string, string>({
    tickets: o.ids.map((id) => ({ id })),
    blockers: {
      held: Object.entries(dependants).map(([id, on]) => ({ ticket: { id }, on: [on] })),
      ticketOf: (b) => b,
      open: async (ts) => ts.map(() => []),
    },
  });
  await schedule.run({
    workers: 2,
    slot: (wanted) => pool.leaseSlot("sandboxes", "alpha next ticket", undefined, POLL, () => !wanted()),
    attempt: async (t, at) => {
      attempts.push(at.n === 2 ? `${t.id}#2` : t.id);
      handed.push(at.slot !== undefined);
      try {
        if (t.id === o.slow && at.n === 1) while (!o.ready(told)) await tick();
        return { kind: "green", green: { issue: t.id } };
      } finally {
        at.slot?.release();
      }
    },
    land: async (g) => {
      // Every landing happens while the slow attempt holds the slot.
      while (!attempts.includes(o.slow)) await tick();
      if (o.conflicts?.includes(g.issue) && !landedOnce.has(g.issue)) {
        landedOnce.add(g.issue);
        return CONFLICT;
      }
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  return { attempts, handed, told };
};

const released = (id: string) => (told: Change[]) => told.some((c) => c.kind === "started" && c.id === id);
const requeued = (id: string) => (told: Change[]) => told.some((c) => c.kind === "requeued" && c.id === id);

test("a ticket released while both workers would wait for the one slot takes that slot when it frees", async () => {
  oneFreeSlot();
  // #1 lands and releases #4 while #2 holds the slot and #3 is queued: #4 starts next, before #3.
  const { attempts, handed, told } = await play({ ids: ["1", "2", "3"], dependants: { 4: "1" }, slow: "2", ready: released("4") });
  assert.deepEqual(attempts, ["1", "2", "4", "3"]);
  assert.ok(handed.every(Boolean), "every attempt began in the slot its worker leased");
  // The queued tickets are the run's demand, whether or not a worker has a slot for them.
  assert.equal(told.flatMap((c) => (c.kind === "demand" ? [c.n] : []))[0], 2);
  assert.equal(mine(), 0, "the run holds no slot once it has ended");
});

test("a ticket requeued after a conflict at landing takes the next free slot, before a ticket queued earlier", async () => {
  oneFreeSlot();
  const { attempts } = await play({ ids: ["1", "2", "3"], slow: "2", conflicts: ["1"], ready: requeued("1") });
  assert.deepEqual(attempts, ["1", "2", "1#2", "3"]);
});

test("a paused run takes no slot for a ticket that has not begun, and a worker waiting for one stops asking", async () => {
  // The pool is full: the worker that has a ticket to start waits for a slot.
  other("beta", { demand: 6, held: 6 });
  let paused: number | undefined;
  const attempts: string[] = [];
  const schedule = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] });
  const running = schedule.run({
    workers: 2,
    pause: { read: () => (paused === undefined ? undefined : { since: paused }), pollMs: POLL },
    slot: (wanted) => pool.leaseSlot("sandboxes", "alpha next ticket", undefined, POLL, () => !wanted()),
    attempt: async (t, at) => {
      attempts.push(t.id);
      at.slot?.release();
      return { kind: "green", green: { issue: t.id } };
    },
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  await until(() => waitEntries().length === 1, "the worker to wait for a slot");
  paused = Math.floor(Date.now() / 1000);
  await until(() => waitEntries().length === 0, "the wait to end with the pause");
  // A slot frees while the run is paused: nobody of this run takes it.
  end("beta");
  await steady(() => mine() === 0 && waitEntries().length === 0, "a paused run took or asked for a slot");
  assert.deepEqual(attempts, []);
  paused = undefined;
  await running;
  assert.deepEqual(attempts, ["1"]);
});
