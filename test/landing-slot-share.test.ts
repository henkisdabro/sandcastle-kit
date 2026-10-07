// The slot a run keeps for landing (src/landing.ts `pipelineWorkers`, `landingSlotNote`; src/pool.ts
// shares): the start line says it is kept only while no other run takes a share, and at a share of
// 1 the pool holds nothing back from tickets - the run's one slot is a ticket's. Expected figures
// are worked by hand: 6 slots split between four runs of demand 5 is 2, 2, 1, 1 (the earlier
// registrations get the odd slots). No Docker, no model.
//
//   node --test test/landing-slot-share.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, heldBy, mine, other, pool, steady, ticket, until } from "./pool-sim.ts";

const { landingSlotNote, pipelineWorkers } = await import("../src/landing.ts");

afterEach(cleanup);

test("the start line says the slot kept for landing is kept only while no other run takes a share", () => {
  const note = landingSlotNote(3);
  assert.equal(
    note,
    "one of the 3 machine-wide sandbox slots is kept for landing while no other run takes a share of them - beside one, tickets may fill this run's share, and a landing goes first when a slot frees",
  );
  // The count it leaves is the pool's one less (never fewer than one worker).
  assert.equal(pipelineWorkers(5, 20, 3, true), 2);
});

test("at a share of 1 the run's one slot goes to a ticket: no slot is held back for landing", async () => {
  other("a", { demand: 5, held: 2, since: 1 });
  other("b", { demand: 5, held: 2, since: 2 });
  other("c", { demand: 5, held: 1, since: 3 });
  pool.joinPool("mine", 5, 5);
  assert.equal(pool.myShare()?.share, 1);
  // One slot is free (2 + 2 + 1 held of 6); the run's share is 1, and a ticket takes it.
  const first = ticket("first");
  await until(() => first.taken, "a ticket to take the run's one slot");
  assert.equal(mine(), 1);
  assert.equal(heldBy(), "1,1,2,2");
  // The pool is full now (6 of 6), and the second ticket waits for a slot to free.
  const second = ticket("second");
  await steady(() => !second.taken, "a second ticket took a slot above the share");
});
