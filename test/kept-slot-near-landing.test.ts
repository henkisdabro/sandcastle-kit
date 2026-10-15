// The pool's kept slot (src/pool.ts `lastFreeSlot`) idles only while a landing is near: some live run's registration says
// it has a ticket in its gates or a green branch queued to land or landing (`landingNear`). With none, a ticket of a run
// that lands takes the last free slot like any free one; a registration without the field is an older kit's and counts as
// near. Two runs of demand 5 on 6 slots split the five shareable slots 3 + 2: run a holds 2 of its 2, this run (share 3) takes three, one slot is left.
// No Docker, no model.
//
//   pnpm test:file test/kept-slot-near-landing.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, heldBy, other, pool, steady, ticket, until } from "./pool-sim.ts";

afterEach(cleanup);

const later = () => Date.now() + 60_000;

/** This run joins the pool with no landing near: the pool keeps the run's registration for the whole test process, so the field is reset. */
const join = () => {
  pool.joinPool("mine", 5, 5);
  pool.setLandingNear(false);
};

test("a ticket takes the kept slot when no registration marks a landing near", async () => {
  join();
  other("a", { demand: 5, held: 2, since: later(), landingNear: false });
  const tickets = [ticket("t0", { keep: true }), ticket("t1", { keep: true }), ticket("t2", { keep: true }), ticket("t3", { keep: true })];
  await until(() => tickets.every((t) => t.taken), "four tickets to take every free slot, the kept one too");
  assert.equal(heldBy(), "2,4");
  assert.deepEqual(tickets[3].why, []);
});

test("a ticket waits for the kept slot while another run's registration marks a landing near", async () => {
  join();
  other("a", { demand: 5, held: 2, since: later(), landingNear: true });
  const tickets = [ticket("t0", { keep: true }), ticket("t1", { keep: true }), ticket("t2", { keep: true })];
  await until(() => tickets.filter((t) => t.taken).length === 3, "three tickets to take the slots before the last");
  const fourth = ticket("t3", { keep: true });
  await steady(() => !fourth.taken, "a ticket took the slot kept for a landing");
  assert.deepEqual(fourth.why, ["landing"]);
});

test("a ticket waits for the kept slot while this run's own field is set", async () => {
  join();
  other("a", { demand: 5, held: 2, since: later(), landingNear: false });
  const tickets = [ticket("t0", { keep: true }), ticket("t1", { keep: true }), ticket("t2", { keep: true })];
  await until(() => tickets.filter((t) => t.taken).length === 3, "three tickets to take the slots before the last");
  pool.setLandingNear(true);
  const fourth = ticket("t3", { keep: true });
  await steady(() => !fourth.taken, "a ticket took the slot kept for this run's own landing");
  assert.deepEqual(fourth.why, ["landing"]);
});

test("a waiting ticket takes the kept slot once the field turns off, and a registration without the field counts as near", async () => {
  join();
  other("a", { demand: 5, held: 2, since: later(), landingNear: true });
  const tickets = [ticket("t0", { keep: true }), ticket("t1", { keep: true }), ticket("t2", { keep: true })];
  await until(() => tickets.filter((t) => t.taken).length === 3, "three tickets to take the slots before the last");
  const fourth = ticket("t3", { keep: true });
  await steady(() => !fourth.taken, "a ticket took the slot kept for a landing");
  other("a", { demand: 5, held: 2, since: later(), landingNear: false });
  await until(() => fourth.taken, "the waiting ticket to take the slot once no landing is near");
  assert.deepEqual(fourth.why, ["landing"]);
  // An older kit's registration (no field) is near.
  other("a", { demand: 5, held: 2, since: later() });
  const fifth = ticket("t4", { keep: true });
  await steady(() => !fifth.taken, "a ticket took the slot beside a registration with no field");
});
