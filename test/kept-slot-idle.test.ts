// The one slot the pool keeps for landing (src/pool.ts `lastFreeSlot`, `shareable`): beside another run the shares
// split the pool less one slot, a run's tickets use their whole share, and the slot left over is any run's landing's -
// a ticket never takes the pool's last free sandbox slot while another run is live, and waits with the reason
// `landing`; a landing may take it whatever its run holds against its share. Figures are worked by hand: six slots
// between three runs of demand 5 split 2, 2, 1 of the five (the earlier registrations get the odd slots), between two
// 3 + 2, between four 2, 1, 1, 1. No Docker, no model.
//
//   pnpm test:file test/kept-slot-idle.test.ts

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, end, heldBy, mine, other, pool, RUN_ID, slots, steady, ticket, until, waiting } from "./pool-sim.ts";

afterEach(cleanup);

/** Later than any run this test file starts: a registration whose `since` puts it after this run's. */
const later = (n: number) => Date.now() + 60_000 + n;

/** Runs a (share 2) and b (share 1) beside this run (share 2, the earliest): five tickets fit, the sixth slot is the landing's. */
const three = (heldA: number, heldB: number) => {
  pool.joinPool("mine", 5, 5);
  other("a", { demand: 5, held: heldA, since: later(1) });
  other("b", { demand: 5, held: heldB, since: later(2) });
  assert.deepEqual(pool.members().map((m) => m.share).sort(), [1, 2, 2]);
};

test("three runs of demand 5 on 6 slots: five tickets and one free slot, the next ticket waits to land and a landing takes the slot", async () => {
  three(2, 1);
  const first = ticket("first", { keep: true });
  const second = ticket("second", { keep: true });
  await until(() => first.taken && second.taken, "two tickets to take this run's whole share");
  assert.equal(heldBy(), "1,2,2", "five tickets are held");
  // One slot is free and no run is below its share, but it is not a ticket's.
  const third = ticket("third", { keep: true });
  await steady(() => !third.taken, "a ticket took the pool's last free slot");
  assert.deepEqual(third.why, ["landing"]);
  const landing = ticket("land", { priority: true });
  await until(() => landing.taken, "this run's landing to take the free slot");
  assert.equal(mine(), 3, "a landing takes it though the run holds its share");
  assert.equal(heldBy(), "1,2,3");
  await steady(() => !third.taken, "a ticket took a slot beside the landing");
});

test("a ticket of a run at its share still never takes the last free slot while another run is live, and goes first once a ticket ends", async () => {
  three(2, 1);
  const first = ticket("first", { keep: true });
  const second = ticket("second", { keep: true });
  await until(() => first.taken && second.taken, "two tickets to take this run's whole share");
  const third = ticket("third", { keep: true });
  await steady(() => !third.taken, "a ticket took the pool's last free slot");
  first.release();
  await until(() => third.taken, "the third ticket to take the slot its own ticket freed");
  assert.equal(mine(), 2);
});

test("a ticket takes the slots before the last free one: a run below its share keeps its whole share", async () => {
  three(2, 0);
  const first = ticket("first", { keep: true });
  const second = ticket("second", { keep: true });
  await until(() => first.taken && second.taken, "two tickets to take this run's whole share");
  assert.equal(heldBy(), "2,2");
  // Run b, below its share of 1, has a free slot to take; this run, at its share, leaves it.
  const third = ticket("third", { keep: true });
  await steady(() => !third.taken, "a ticket took a slot run b is below its share for");
  assert.deepEqual(third.why, ["share"]);
  other("b", { demand: 5, held: 1, since: later(2) });
  await steady(() => !third.taken, "a ticket took the slot kept for landing once run b had its share");
  assert.deepEqual(third.why, ["share", "landing"]);
});

test("a landing of this run takes the last free slot ahead of another run's younger landing, and waits for an older one", async () => {
  three(2, 1);
  const first = ticket("first", { keep: true });
  const second = ticket("second", { keep: true });
  await until(() => first.taken && second.taken, "two tickets to take this run's whole share");
  // Run a holds its share and its landing has waited longer: it goes first, though a is not below its share.
  waiting("a", Date.now() - 5000, true);
  const landing = ticket("land", { priority: true });
  await steady(() => !landing.taken, "this run's landing took the slot ahead of an older landing of run a");
  // A younger landing of run a does not hold this one back.
  end("a");
  other("a", { demand: 5, held: 2, since: later(1) });
  waiting("a", Date.now() + 60_000, true);
  await until(() => landing.taken, "this run's landing to take the slot ahead of a younger landing");
});

test("a ticket's wait for the last free slot is not on file: it would hold another run's landing back and take nothing", async () => {
  pool.joinPool("mine", 5, 5);
  other("a", { demand: 5, held: 4, since: later(1) });
  other("b", { demand: 5, held: 0, since: later(2) });
  const first = ticket("first", { keep: true });
  await until(() => first.taken, "a ticket to take a slot of the share");
  // Five held and one free: this run holds 1 of its share of 2 and still may not take the last free slot.
  const second = ticket("second", { keep: true });
  await until(() => second.why.includes("landing"), "the second ticket to wait to land");
  await steady(() => !second.taken && existsSync(join(slots, "waits")) && readdirSync(join(slots, "waits")).length === 0, "the kept-back ticket's wait entry is on file");
});

test("a run over its share after the split keeps every slot it holds and shrinks as its tickets end", async () => {
  pool.joinPool("mine", 5, 5);
  const held = [1, 2, 3, 4, 5].map((n) => ticket(`t${n}`, { keep: true }));
  await until(() => held.every((t) => t.taken), "a run alone to take its demand");
  // Registered before this run whatever the five takes above cost: a `since` only a second back fell after this run's
  // own on a loaded machine, which then got the odd slot (share 3) and let the next ticket take it.
  other("a", { demand: 5, since: 1 });
  assert.deepEqual(Object.fromEntries(pool.members().map((m) => [m.run, m.share])), { [RUN_ID]: 2, a: 3 });
  await steady(() => mine() === 5, "a slot was taken back from a running ticket");
  held[0]!.release();
  held[1]!.release();
  held[2]!.release();
  await until(() => mine() === 2, "the run to shrink to its share as its tickets end");
  const next = ticket("next", { keep: true });
  await steady(() => !next.taken && mine() === 2, "a ticket took a slot above the share");
});

test("a landing of a run at its share takes a free slot that is not the last, while another run below its share asks for none", async () => {
  // Before the pool kept one slot for all runs, a run's tickets stopped one short of its share and its landing fitted
  // in the share; now they fill it, so a landing held to the share waited with slots free until run b took its own.
  pool.joinPool("mine", 5, 5);
  other("b", { demand: 5, held: 1, since: later(1) });
  assert.deepEqual(Object.fromEntries(pool.members().map((m) => [m.run, m.share])), { [RUN_ID]: 3, b: 2 });
  const held = [1, 2, 3].map((n) => ticket(`t${n}`, { keep: true }));
  await until(() => held.every((t) => t.taken), "three tickets to take this run's whole share");
  const landing = ticket("land", { priority: true });
  await until(() => landing.taken, "the landing to take one of the two free slots");
  assert.equal(mine(), 4);
  // The landing's slot is past the share, not a ticket's: a ticket still waits beside it.
  const ticketAfter = ticket("t4", { keep: true });
  await steady(() => !ticketAfter.taken, "a ticket took a slot past the share beside the landing");
});
