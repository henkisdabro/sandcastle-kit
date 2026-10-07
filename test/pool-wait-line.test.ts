// A ticket waiting for a machine-wide slot says why once when the wait starts, and again only after a
// further 15 minutes: with a second run live the reason flips between "share" and "slots", and one wait
// printed about 30 lines in two hours. `onWait` still fires at every change of reason, since the run's
// "waits for its share" note follows it.
//
// This process is one run and the other is a file (test/pool-sim.ts); the clock the pool reads is ours.
//
//   node --test test/pool-wait-line.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { cleanup, other, pool, RUN_ID, said, setHeld, sleep, ticket, until, waiting } from "./pool-sim.ts";

const { inject, joinPool } = pool;

let now = Date.now();
inject({ probe: everyPidIsTheKit, now: () => now });
afterEach(async () => {
  await cleanup();
  now = Date.now();
});

const MINUTE = 60_000;
const lines = () => said.filter((l) => l.includes("waiting for a machine-wide sandboxes slot"));
/** Lets the waiting ticket look at the pool a few times. */
const looks = () => sleep(30);

test("a wait whose reason flips prints one line, then one more after 15 minutes naming the current reason", async () => {
  joinPool("alpha", 6, 6);
  other("beta", { demand: 6, held: 3 });
  setHeld(RUN_ID, 3);
  const t = ticket("flipper");
  await until(() => t.why.length === 1, "the first reason");
  assert.deepEqual(t.why, ["slots"]);
  assert.equal(lines().length, 1);
  assert.match(lines()[0]!, /flipper: waiting for a machine-wide sandboxes slot \(6 in use\)/);

  // The other run waits below its share while this one holds its own: "share", then back to "slots", and again.
  const flip = async (to: "share" | "slots") => {
    if (to === "share") waiting("beta", Date.now());
    setHeld("beta", to === "share" ? 2 : 3);
    const before = t.why.length;
    await until(() => t.why.length > before, `the reason to change to ${to}`);
    assert.equal(t.why.at(-1), to);
  };
  await flip("share");
  await flip("slots");
  await flip("share");
  assert.deepEqual(t.why, ["slots", "share", "slots", "share"], "onWait fires at every change");
  assert.equal(lines().length, 1, "a change of reason alone prints nothing");

  now += 14 * MINUTE;
  await looks();
  assert.equal(lines().length, 1, "still quiet before the 15 minutes");

  now += MINUTE;
  await until(() => lines().length === 2, "the line after 15 minutes");
  assert.match(lines()[1]!, /flipper: waiting for a machine-wide sandboxes slot \(this run's share is 3 and it holds 3, another run waits below its own\)/);
  assert.equal(t.why.length, 4, "the repeat is no change for onWait");

  await flip("slots");
  assert.equal(lines().length, 2, "the interval starts again from the last line");
});
