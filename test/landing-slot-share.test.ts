// The slot kept for landing (src/landing.ts `pipelineWorkers`, `landingSlotNote`; src/pool.ts shares and
// `leaseSlot`'s `keep`): alone, the run's workers leave one of the machine's slots; beside another run it is one slot
// of the pool for any run's landing, outside every run's share - the shares split the pool less one slot, a run's
// tickets use their whole share, and no ticket takes the pool's last free slot. Expected figures are worked by hand:
// the 5 slots left split between three runs of demand 5 is 2, 2, 1, and between two 3, 2 (the earlier registrations
// get the odd slots). No Docker, no model.
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

test("the start line says one of the machine's slots is kept for landing, and beside another run that it is any run's, outside the shares", () => {
  // Alone, nothing of another run: the clause for one reads as though one were live.
  assert.equal(landingSlotNote(3), "one of the 3 machine-wide sandbox slots is kept for landing");
  assert.equal(landingSlotNote(3, true), "one of the 3 machine-wide sandbox slots is kept for landing - beside another run, for any run's landing, outside every run's share");
  // The count it leaves is the pool's one less (never fewer than one worker).
  assert.equal(pipelineWorkers(5, 20, 3, true), 2);
  assert.equal(pipelineWorkers(5, 20, 1, true), 1);
  assert.equal(pipelineWorkers(5, 20, 3, false), 5, "a dry run lands nothing and leaves no slot");
});

test("a run alone keeps no slot of its share in the pool: its worker count already leaves one of the machine's", async () => {
  pool.joinPool("mine", 3, 3);
  assert.equal(pool.myShare()?.share, 3);
  const tickets = [ticket("t0", { keep: true }), ticket("t1", { keep: true }), ticket("t2", { keep: true })];
  await until(() => tickets.every((t) => t.taken), "three tickets of a run alone to take three slots");
  assert.equal(mine(), 3);
});

test("at a share of 2 beside a run of share 3, a third ticket waits while a landing takes the free slot", async () => {
  other("a", { demand: 5, held: 3, since: 1 });
  pool.joinPool("mine", 5, 5);
  assert.equal(pool.myShare()?.share, 2, "the 5 slots less the landing slot, 3 + 2");
  const first = ticket("first", { keep: true });
  const second = ticket("second", { keep: true });
  await until(() => first.taken && second.taken, "two tickets to take the run's whole share");
  // One slot is free of the machine's, but it is the pool's landing slot.
  const third = ticket("third", { keep: true });
  await steady(() => !third.taken, "a third ticket took the slot kept for landing");
  assert.deepEqual(third.why, ["landing"]);
  const landing = ticket("land", { priority: true });
  await until(() => landing.taken, "the landing to take the free slot");
  assert.equal(heldBy(), "3,3");
  await steady(() => !third.taken, "a third ticket took a slot beside the landing");
  // A ticket ends: the slot it frees is the pool's last free one again, so the third waits until the landing is done.
  first.release();
  await steady(() => !third.taken, "a ticket took the last free slot beside the landing");
  landing.release();
  await until(() => third.taken, "the third ticket to take a slot once the landing ended");
  assert.equal(mine(), 2);
});

test("a ticket kept back for landing leaves no wait entry that would hold another run back", async () => {
  other("a", { demand: 5, held: 2, since: 1 });
  other("b", { demand: 5, held: 1, since: 3_000_000_000_000 });
  pool.joinPool("mine", 5, 5);
  assert.equal(pool.myShare()?.share, 2);
  const first = ticket("first", { keep: true });
  const second = ticket("second", { keep: true });
  await until(() => first.taken && second.taken, "two tickets to take the run's whole share");
  const third = ticket("third", { keep: true });
  await steady(() => !third.taken, "a third ticket took the slot kept for landing");
  // An older wait of this run that cannot take the slot would make a landing of another run leave it idle.
  assert.deepEqual(myWaits(), []);
  const landing = ticket("land", { priority: true });
  await until(() => landing.taken, "the landing to take the free slot");
  assert.equal(heldBy(), "1,2,3");
  landing.release();
  first.release();
  await until(() => third.taken, "the third ticket to take a slot once the landing ended");
});

test("at a share of 1 the run's one slot goes to a ticket, and its next ticket waits for the landing slot", async () => {
  other("a", { demand: 5, held: 2, since: 1 });
  other("b", { demand: 5, held: 1, since: 2 });
  other("c", { demand: 5, held: 1, since: 3 });
  pool.joinPool("mine", 5, 5);
  assert.equal(pool.myShare()?.share, 1);
  // Two slots are free (2 + 1 + 1 held of 6); the run's share is 1, and a ticket takes one.
  const first = ticket("first", { keep: true });
  await until(() => first.taken, "a ticket to take the run's one slot");
  assert.equal(mine(), 1);
  assert.equal(heldBy(), "1,1,1,2");
  // The last free slot is a landing's: the second ticket waits for it, and a landing takes it.
  const second = ticket("second", { keep: true });
  await steady(() => !second.taken, "a second ticket took a slot above the share");
  const landing = ticket("land", { priority: true });
  await until(() => landing.taken, "the landing to take the slot");
  assert.equal(heldBy(), "1,1,2,2");
});

// burndown() needs Docker, so its call site is held by its text: a ticket pipeline's slot keeps off the pool's slot for
// landing, a dry run's too - the slot is any run's, so a dry run that took it held a real run's landing back.
test("a run's ticket pipelines lease their slots keeping off the pool's slot for landing, a dry run's too", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /const sandboxSlot = [^]*?leaseSlot\("sandboxes", `\$\{project\.name\} \$\{label\}`, wait\.onWait, undefined, giveUp, false, true\)/);
});
