// A landing's claim on the gates pool (src/pool.ts `claimSlot`) holds a ticket gate back only while the free gates slots
// are no more than the run's claims: with `maxGates` above 1 and a slot to spare, ticket gates would otherwise idle with
// free slots through every landing's merge. Its own file: the pool reads its gates limit once, and the claim's other tests
// (test/pool-landing-claim.test.ts) need a limit of 1.
//
//   pnpm test:file test/pool-landing-claim-spare.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, pool, POLL, steady, until } from "./pool-sim.ts";

// Before the pool first reads its gates limit, which it keeps.
process.env.SANDCASTLE_MAX_GATES = "2";
const { claimSlot, limit, withSlot } = pool;

const made: { release: () => void; done: Promise<void> }[] = [];
afterEach(async () => {
  const gates = made.splice(0);
  for (const g of gates) g.release();
  await cleanup();
  await Promise.allSettled(gates.map((g) => g.done));
});

const gate = (log: string[], label: string, priority = false, claim?: ReturnType<typeof claimSlot>) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const g = { waits: false, held: false, release, done: undefined as unknown as Promise<void> };
  g.done = withSlot("gates", label, async () => {
    g.held = true;
    log.push(label);
    await hold;
  }, () => (g.waits = true), POLL, priority, false, undefined, claim);
  made.push(g);
  return g;
};

test("with a gates slot to spare beyond the run's claims, a ticket gate takes it during a landing's merge", async () => {
  assert.equal(limit("gates"), 2);
  const log: string[] = [];
  const claim = claimSlot("gates");
  // Two free slots, one claim: the first ticket gate goes on.
  const first = gate(log, "first ticket gate");
  await until(() => first.held, "the first ticket gate's slot, one being spare");
  // One free slot, one claim: it is the landing's, and the second ticket gate waits.
  const second = gate(log, "second ticket gate");
  await until(() => second.waits, "the second ticket gate's wait");
  await steady(() => !second.held, "the second ticket gate left the last free slot to the landing's claim", 100);
  const landing = gate(log, "landing gate", true, claim);
  await until(() => landing.held, "the landing gate's slot");
  assert.equal(second.held, false);
  claim.release();
  landing.release();
  await until(() => second.held, "the second ticket gate's slot, once the landing gate is done");
  first.release();
  second.release();
  await Promise.all([first.done, second.done, landing.done]);
  assert.deepEqual(log, ["first ticket gate", "landing gate", "second ticket gate"]);
});
