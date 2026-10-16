// A ticket whose sandbox only waits for a gates slot moves its lease to an uncounted lock (src/pool.ts
// `uncountSlot`): the container lives on and the machine-wide readings (`usage()`, the status view's
// `sandboxes-*.lock` count) still count it, but it is no part of the limit, the run's shares or the slot
// kept for landing, so another ticket's agent pass takes the numbered slot. The pool is the real one in a
// temp cache; the other processes are files (test/pool-sim.ts).
//
//   pnpm test:file test/gate-wait-frees-sandbox.test.ts

import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, deadPid, mine, other, POLL, pool, RUN_ID, slots, steady, until } from "./pool-sim.ts";

process.env.SANDCASTLE_MAX_SANDBOXES = "2";

const { leaseSlot, liveSlots, members, uncountSlot, usage } = pool;

afterEach(cleanup);

const locks = () => (existsSync(slots) ? readdirSync(slots).filter((f) => f.endsWith(".lock")).sort() : []);

test("a lease moved to the uncounted lock lets a third lease take a numbered slot, and the pool reads 3/2", async () => {
  const first = await leaseSlot("sandboxes", "alpha #1");
  const second = await leaseSlot("sandboxes", "alpha #2");
  let third: Awaited<ReturnType<typeof leaseSlot>> | undefined;
  void leaseSlot("sandboxes", "alpha #3", undefined, POLL).then((lease) => (third = lease));
  await steady(() => third === undefined, "both numbered slots are held: the third lease waits");

  const waiting = uncountSlot(first, "alpha #1 gates");
  await until(() => third !== undefined, "the third lease to take the freed numbered slot");

  assert.equal(usage(), "sandboxes 3/2 · gates 0/1");
  assert.equal(members().find((m) => m.run === RUN_ID)?.held, 2, "the run's held count is the numbered slots");
  assert.equal(mine(), 2);
  assert.deepEqual(liveSlots("sandboxes", undefined, true).map((l) => l.label).sort(), ["alpha #1 gates", "alpha #2", "alpha #3"]);
  assert.deepEqual(locks().filter((f) => f.startsWith("sandboxes-")).map((f) => f.replace(RUN_ID, "<run>")), ["sandboxes-0.lock", "sandboxes-1.lock", "sandboxes-waiting-<run>-0.lock"], "named so the status view's sandboxes-*.lock count reads it");

  // The first lease is spent: releasing it again frees nothing of the third's.
  first.release();
  assert.equal(usage(), "sandboxes 3/2 · gates 0/1");

  waiting.release();
  assert.equal(usage(), "sandboxes 2/2 · gates 0/1", "released, the uncounted lock leaves the reading");
  waiting.release();
  second.release();
  third!.release();
  assert.deepEqual(locks(), []);
});

test("an uncounted lock is no part of the run's shares or the slot kept for landing: a ticket's lease still takes the second numbered slot", async () => {
  // Beside another run, a ticket's lease (`keep`) never takes the pool's last free slot. With the uncounted lock counted, one
  // slot would already read as taken and the second lease would wait for the first to end.
  pool.joinPool("alpha", 2, 2);
  other("beta", { demand: 2, held: 0, since: Date.now() + 10_000 });
  const first = await leaseSlot("sandboxes", "alpha #1", undefined, POLL, undefined, false, true);
  const waiting = uncountSlot(first, "alpha #1 gates");
  assert.equal(members().find((m) => m.run === RUN_ID)?.held, 0);
  const second = await leaseSlot("sandboxes", "alpha #2", undefined, POLL, undefined, false, true);
  assert.equal(usage(), "sandboxes 2/2 · gates 0/1");
  assert.equal(members().find((m) => m.run === RUN_ID)?.held, 1);
  waiting.release();
  second.release();
});

test("a dead holder's uncounted lock counts for nothing, and the next one taken removes its file", async () => {
  const dead = join(slots, "sandboxes-waiting-deadrun-0.lock");
  const first = await leaseSlot("sandboxes", "alpha #1");
  writeFileSync(dead, `${deadPid()} token-dead run=deadrun a gone ticket\n`);
  assert.equal(usage(), "sandboxes 1/2 · gates 0/1");
  assert.deepEqual(liveSlots("sandboxes", undefined, true).map((l) => l.label), ["alpha #1"]);

  const waiting = uncountSlot(first, "alpha #1 gates");
  assert.equal(existsSync(dead), false, "swept by the next uncounted lock taken");
  assert.equal(usage(), "sandboxes 1/2 · gates 0/1");
  waiting.release();
  assert.deepEqual(locks(), []);
});
