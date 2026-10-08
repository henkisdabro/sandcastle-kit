// A paused run (`sandcastle pause`) gives its sandbox slots to the other runs on the machine: each parked
// ticket's sandbox is closed and its slot released (`leaseSlot`, src/pool.ts), and the run's demand is told
// as 0, so its share goes to the others. On the resume the demand comes back and the tickets lease their
// slots again within the run's share. This process is one run and the other is files (test/pool-sim.ts).
//
//   pnpm test:file test/pause-pool.test.ts

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, end, heldBy, mine, other, pool, RUN_ID, slots, steady, until } from "./pool-sim.ts";

const { joinPool, leaseSlot, members, setDemand } = pool;

afterEach(cleanup);

const shares = () => Object.fromEntries(members().map((m) => [m.project ?? m.run, m.share]));

test("a paused run's demand is 0, so another run's share is the whole pool until the resume", async () => {
  joinPool("alpha", 3, 3);
  other("beta", { demand: 6, held: 0 });
  assert.deepEqual(shares(), { alpha: 3, beta: 3 }, "two runs wanting the pool split it");

  // Three tickets with a sandbox each.
  const leases = await Promise.all([0, 1, 2].map((i) => leaseSlot("sandboxes", `alpha ticket ${i}`, undefined, 2)));
  assert.equal(mine(), 3);

  // The pause: every ticket reached a juncture, closed its sandbox and gave its slot back, and the run told a demand of 0.
  for (const lease of leases) lease.release();
  setDemand(0);
  assert.equal(mine(), 0, "the paused run holds no slot");
  assert.deepEqual(shares(), { alpha: 0, beta: 6 }, "the whole pool is the other run's share");
  const me = members().find((m) => m.run === RUN_ID)!;
  assert.deepEqual({ demand: me.demand, held: me.held, share: me.share }, { demand: 0, held: 0, share: 0 });

  // The resume: the demand returns, and the share with it.
  setDemand(3);
  assert.deepEqual(shares(), { alpha: 3, beta: 3 });
});

test("a ticket resumed after a pause leases a slot within its run's share, and a lease released twice frees one slot", async () => {
  joinPool("alpha", 3, 3);
  other("beta", { demand: 6, held: 4 });
  setDemand(0);
  assert.equal(heldBy(), "4", "only the other run holds slots");

  // The resume: 2 slots are free and the share is 3, so two tickets lease at once and the third waits for the other run's tickets.
  setDemand(3);
  const waited: string[] = [];
  const leasing = [0, 1, 2].map((i) => leaseSlot("sandboxes", `alpha ticket ${i}`, (why) => waited.push(why), 2));
  await until(() => mine() === 2, "two tickets to take the free slots");
  await steady(() => mine() === 2, "a third slot was taken above what is free");
  assert.equal(waited.length, 1, "the third waits, and says why once");
  const [first, second] = await Promise.all(leasing.slice(0, 2));
  first!.release();
  first!.release();
  assert.equal(mine(), 1, "a second release of the same lease frees nothing more");
  // The other run's tickets finish: the waiting one gets its slot, and the test leaves nothing held.
  end("beta");
  const third = await leasing[2]!;
  assert.equal(mine(), 2);
  second!.release();
  third.release();
  assert.equal(mine(), 0);
});

test("a ticket waiting for a slot stops waiting once the run is paused, and leaves no wait entry behind", async () => {
  joinPool("alpha", 3, 3);
  other("beta", { demand: 6, held: 6 });
  const waits = join(slots, "waits");
  const entries = () => (existsSync(waits) ? readdirSync(waits).filter((f) => f.endsWith(".wait")) : []);
  let paused = false;
  const told: string[] = [];
  const leasing = leaseSlot("sandboxes", "alpha ticket", (why) => told.push(why), 2, () => paused);
  await until(() => told.length === 1 && entries().length === 1, "the ticket to wait for a slot");
  paused = true;
  assert.equal(await leasing, undefined, "no lease: the wait was given up");
  assert.deepEqual(entries(), [], "and its place in the queue went with it");
  assert.equal(mine(), 0);
  assert.equal(heldBy(), "6", "only the other run holds slots");
});

test("a slot that is free is taken whether or not the run is paused: the ticket then parks at its start and gives it back", async () => {
  joinPool("alpha", 3, 3);
  const lease = await leaseSlot("sandboxes", "alpha ticket", undefined, 2, () => true);
  assert.ok(lease, "giving up is for a wait, not for a free slot");
  assert.equal(mine(), 1);
  lease!.release();
});
