// The slot a run keeps for landing (src/pool.ts `keptForLanding`) is not idle while no landing of that run waits:
// another run at or above its share may take it, which the owner's share sums count as the owner's own
// (`heldWithKept`). The owner's landing then goes first when a slot frees. Six slots between four runs of demand 5
// split 2, 2, 1, 1 (the earlier registrations get the odd slots), worked by hand. A pool of 3 split 2 + 1 is the same
// stand-off: the run of share 2 holds one ticket and keeps one slot, the run of share 1 holds one and gave way.
// No Docker, no model.
//
//   pnpm test:file test/kept-slot-idle.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, heldBy, mine, other, pool, steady, ticket, until, waiting } from "./pool-sim.ts";

afterEach(cleanup);

/** Runs a (share 2, one ticket, the kept slot idle), b (share 2, full), c (share 1, full) and this run (share 1). */
const beside = () => {
  other("a", { demand: 5, held: 1, since: 1 });
  other("b", { demand: 5, held: 2, since: 2 });
  other("c", { demand: 5, held: 1, since: 3 });
  pool.joinPool("mine", 5, 5);
};

test("a run of share 1 takes the slot another run of share 2 keeps for landing while no landing of it waits", async () => {
  beside();
  const first = ticket("first", { keep: true });
  await until(() => first.taken, "a ticket to take the run's one slot");
  // Five of six held; the sixth is run a's kept slot, idle: a has no wait entry and nothing to land.
  const second = ticket("second", { keep: true });
  await until(() => second.taken, "a second ticket to take the idle kept slot");
  assert.equal(mine(), 2);
  assert.equal(heldBy(), "1,1,2,2");
});

test("run a's landing, once it waits, makes this run give way: the next freed slot is not taken", async () => {
  beside();
  const first = ticket("first", { keep: true });
  const second = ticket("second", { keep: true });
  await until(() => first.taken && second.taken, "two tickets to take the run's slot and the idle kept one");
  waiting("a", Date.now());
  first.release();
  await until(() => mine() === 1, "a slot to free");
  const third = ticket("third", { keep: true });
  await steady(() => !third.taken, "a ticket took the slot freed for run a's landing");
});

test("a run of share 1 still gives way to a run of share 2 that has a ticket waiting below its share", async () => {
  beside();
  const first = ticket("first", { keep: true });
  await until(() => first.taken, "a ticket to take the run's one slot");
  // Run a's ticket waits (visible: it is not kept back, a holds fewer than share - 1 tickets' worth): a is below its share.
  other("a", { demand: 5, held: 0, since: 1 });
  waiting("a", Date.now());
  const second = ticket("second", { keep: true });
  await steady(() => !second.taken, "a ticket took a slot run a waits for below its share");
});
