// A run whose tickets only wait for a gates slot off the count (`uncountSlot`, #790) leaves the free sandbox slots to a run
// with tickets queued (#1014): its scheduler tells a demand of the tickets that hold or ask for a counted slot
// (createSchedule in src/schedule.ts), so its share (src/pool.ts `members`) covers no slot it cannot use, and the other
// run is not held at its share (`overShare`) while those slots sit free.
//
// This process is run A; run B is files (test/pool-sim.ts). B's registration carries the demand B's scheduler tells,
// driven through its ports with fake work: one ticket implementing on a counted slot, two moved off the count to wait for
// the gates pool. No git, no Docker, no network.
//
//   pnpm test:file test/pool-share-gate-wait.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, heldBy, mine, other, pool, slots, steady, ticket, until } from "./pool-sim.ts";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, type Slot } from "../src/schedule.ts";

const { joinPool, members } = pool;

afterEach(cleanup);

type T = { id: string };
type G = { issue: string };
const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const MERGED: Landed = { kind: "merged" };

/** Run B's scheduler: three tickets, two of them off the count waiting for gates. The demand it tells once they are off, and its end. */
const runB = async () => {
  const told: Change<G, string>[] = [];
  let open!: () => void;
  const gates = new Promise<void>((resolve) => (open = resolve));
  let off = 0;
  const done = createSchedule<T, G, string>({ tickets: [{ id: "B1" }, { id: "B2" }, { id: "B3" }] }).run({
    workers: 3,
    concurrency: 3,
    gateWaiters: 2,
    slot: async (wanted): Promise<Slot | undefined> => (wanted() ? { release: () => {} } : undefined),
    attempt: async (t, at) => {
      if (t.id !== "B1") {
        at.gates();
        assert.equal(at.gateWait(), true);
        at.slot?.release();
        off++;
      }
      await gates;
      return green(t.id);
    },
    land: async () => MERGED,
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  await until(() => off === 2, "B's two tickets to move off the count");
  const demand = told.flatMap((c) => (c.kind === "demand" ? [c.n] : [])).at(-1)!;
  return { demand, end: () => (open(), done) };
};

test("a run whose tickets only wait for gates leaves the free sandbox slots to a run that has tickets queued", async () => {
  const b = await runB();
  joinPool("a", 5, 5);
  const two = [ticket("a0"), ticket("a1")];
  await until(() => two.every((t) => t.taken), "A's two tickets");
  other("b", { demand: b.demand, held: 1 });
  // B's two gate waiters, on locks outside the count as `uncountSlot` writes them.
  const bLock = readdirSync(slots).find((f) => f.endsWith(".lock") && readFileSync(join(slots, f), "utf8").includes(" run=b "))!;
  const bPid = readFileSync(join(slots, bLock), "utf8").split(" ")[0];
  for (const n of [0, 1]) writeFileSync(join(slots, `sandboxes-waiting-b-${n}.lock`), `${bPid} token-b-w${n} run=b waiting for a gates slot\n`);
  const third = ticket("a2", { keep: true });
  await until(() => third.taken, `A's third ticket, with 3 of 6 slots free (waits for ${JSON.stringify(third.why)}, members ${JSON.stringify(members())})`);
  assert.equal(mine(), 3);
  await steady(() => heldBy() === "1,3", "the slot kept for landing stays free");
  await b.end();
});
