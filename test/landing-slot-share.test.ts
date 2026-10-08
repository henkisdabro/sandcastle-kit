// The slot a run keeps for landing (src/landing.ts `pipelineWorkers`, `landingSlotNote`; src/pool.ts
// shares and `leaseSlot`'s `keep`): alone, the run's workers leave one of the machine's slots; beside another
// run, while its share is 2 or more, its ticket pipelines hold no more than share - 1, and a landing takes the
// last; at a share of 1 the pool holds nothing back from tickets - the run's one slot is a ticket's. Expected
// figures are worked by hand: 6 slots split between four runs of demand 5 is 2, 2, 1, 1, between three 2, 2, 2,
// and between two 3, 3 (the earlier registrations get the odd slots). No Docker, no model.
//
//   pnpm test:file test/landing-slot-share.test.ts

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, heldBy, mine, other, pool, RUN_ID, slots, steady, ticket, until } from "./pool-sim.ts";

const { landingSlotNote, pipelineWorkers } = await import("../src/landing.ts");

afterEach(cleanup);

/** This run's wait entries, as another run reads them from the waits directory. */
const myWaits = () => {
  const dir = join(slots, "waits");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wait") && readFileSync(join(dir, f), "utf8").split(" ")[1] === RUN_ID) : [];
};

test("the start line says a slot is kept for landing, of this run's share beside another run while that is 2 or more", () => {
  const note = landingSlotNote(3);
  assert.equal(
    note,
    "one of the 3 machine-wide sandbox slots is kept for landing - beside another run, one of this run's share while it is 2 or more, and at a share of 1 a landing goes first when a slot frees",
  );
  // The count it leaves is the pool's one less (never fewer than one worker).
  assert.equal(pipelineWorkers(5, 20, 3, true), 2);
});

test("a run alone keeps no slot of its share in the pool: its worker count already leaves one of the machine's", async () => {
  pool.joinPool("mine", 3, 3);
  assert.equal(pool.myShare()?.share, 3);
  const tickets = [ticket("t0", { keep: true }), ticket("t1", { keep: true }), ticket("t2", { keep: true })];
  await until(() => tickets.every((t) => t.taken), "three tickets of a run alone to take three slots");
  assert.equal(mine(), 3);
});

test("at a share of 3 beside another run, a third ticket waits while a landing takes the kept slot", async () => {
  other("a", { demand: 5, held: 3, since: 1 });
  pool.joinPool("mine", 5, 5);
  assert.equal(pool.myShare()?.share, 3);
  const first = ticket("first", { keep: true });
  const second = ticket("second", { keep: true });
  await until(() => first.taken && second.taken, "two tickets to take two slots of the share");
  // Three slots are free of the machine's, but the third of the share is kept for landing.
  const third = ticket("third", { keep: true });
  await steady(() => !third.taken, "a third ticket took the slot kept for landing");
  assert.deepEqual(third.why, ["landing"]);
  const landing = ticket("land", { priority: true });
  await until(() => landing.taken, "the landing to take the kept slot");
  assert.equal(heldBy(), "3,3");
  await steady(() => !third.taken, "a third ticket took a slot beside the landing");
  // A ticket ends: the third takes its place, two tickets beside the landing.
  first.release();
  await until(() => third.taken, "the third ticket to take the freed slot");
  assert.equal(mine(), 3);
});

test("at a share of 2, a ticket kept back for landing leaves no wait entry that would hold another run back", async () => {
  other("a", { demand: 5, held: 2, since: 1 });
  other("b", { demand: 5, held: 1, since: 2 });
  pool.joinPool("mine", 5, 5);
  assert.equal(pool.myShare()?.share, 2);
  const first = ticket("first", { keep: true });
  await until(() => first.taken, "a ticket to take one slot of the share");
  const second = ticket("second", { keep: true });
  await steady(() => !second.taken, "a second ticket took the slot kept for landing");
  // Run b is below its share: an older wait of this run that cannot take a slot would make b leave the free ones idle.
  assert.deepEqual(myWaits(), []);
  const landing = ticket("land", { priority: true });
  await until(() => landing.taken, "the landing to take the kept slot");
  assert.equal(heldBy(), "1,2,2");
  first.release();
  await until(() => second.taken, "the second ticket to take the freed slot");
});

test("at a share of 1 the run's one slot goes to a ticket: no slot is held back for landing", async () => {
  other("a", { demand: 5, held: 2, since: 1 });
  other("b", { demand: 5, held: 2, since: 2 });
  other("c", { demand: 5, held: 1, since: 3 });
  pool.joinPool("mine", 5, 5);
  assert.equal(pool.myShare()?.share, 1);
  // One slot is free (2 + 2 + 1 held of 6); the run's share is 1, and a ticket takes it.
  const first = ticket("first", { keep: true });
  await until(() => first.taken, "a ticket to take the run's one slot");
  assert.equal(mine(), 1);
  assert.equal(heldBy(), "1,1,2,2");
  // The pool is full now (6 of 6), and the second ticket waits for a slot to free.
  const second = ticket("second", { keep: true });
  await steady(() => !second.taken, "a second ticket took a slot above the share");
});

// burndown() needs Docker, so its call site is held by its text: a ticket pipeline's slot keeps one of the share
// for landing, and a dry run, which lands nothing, keeps none.
test("a run's ticket pipelines lease their slots keeping one of the share for landing, unless it is a dry run", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /const sandboxSlot = [^]*?leaseSlot\("sandboxes", `\$\{project\.name\} \$\{label\}`, wait\.onWait, undefined, giveUp, false, !DRY_RUN\)/);
});
