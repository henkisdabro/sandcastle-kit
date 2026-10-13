// A landing that will gate claims the run's gates slot when it holds its sandbox slot, before its gates ask for one: a
// ticket gate asked during the landing's merge yields to it (src/pool.ts `claimSlot`), where it used to take the slot and
// hold it for a whole gate run. The claim yields only while the free gates slots are no more than the run's claims.
//
//   pnpm test:file test/pool-landing-claim.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, pool, POLL, said, steady, until } from "./pool-sim.ts";

const { claimSlot, withSlot } = pool;

const made: { release: () => void; done: Promise<void> }[] = [];
afterEach(async () => {
  const gates = made.splice(0);
  for (const g of gates) g.release();
  await cleanup();
  await Promise.allSettled(gates.map((g) => g.done));
});

/** One gate of this run asking for the gates pool: it records that it holds a slot, and keeps it until `release()`. */
const gate = (log: string[], label: string, priority = false) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const g = { waits: false, held: false, release, done: undefined as unknown as Promise<void> };
  g.done = withSlot("gates", label, async () => {
    g.held = true;
    log.push(label);
    await hold;
  }, () => (g.waits = true), POLL, priority);
  made.push(g);
  return g;
};

test("a landing gate asked after a ticket gate, during the landing's merge, still takes the slot first", async () => {
  const log: string[] = [];
  const claim = claimSlot("gates");
  // The landing is merging: a ticket gate asks for the one gates slot, which is free, and leaves it to the landing.
  const ticket = gate(log, "ticket gate");
  await until(() => ticket.waits, "the ticket gate's wait");
  await steady(() => !ticket.held, "the ticket gate left the free slot to the landing's claim", 100);
  assert.ok(said.some((line) => /ticket gate: waiting for a machine-wide gates slot \(a landing, base or verify gate of this run goes first\)/.test(line)), said.join("\n"));

  // The merge is done and the landing gate asks: its wait spends the claim, and it is the one served.
  const landing = gate(log, "landing gate", true);
  await until(() => landing.held, "the landing gate's slot");
  assert.equal(ticket.held, false);
  claim.release();
  landing.release();
  await until(() => ticket.held, "the ticket gate's slot, once the landing gate is done");
  ticket.release();
  await Promise.all([ticket.done, landing.done]);
  assert.deepEqual(log, ["landing gate", "ticket gate"]);
});

test("a landing that ends without gating releases its claim and the waiting ticket gate takes the slot", async () => {
  const log: string[] = [];
  const claim = claimSlot("gates");
  const ticket = gate(log, "ticket gate");
  await steady(() => !ticket.held, "the ticket gate waited while the landing's claim stood", 60);
  claim.release();
  await until(() => ticket.held, "the ticket gate's slot, once the claim is released");
  claim.release();
  ticket.release();
  await ticket.done;
});

test("a claim is spent by the landing's own wait: a ticket gate asked after it waits only for that wait", async () => {
  const log: string[] = [];
  claimSlot("gates");
  const holder = gate(log, "holder", true);
  await until(() => holder.held, "the priority holder's slot");
  holder.release();
  await holder.done;
  // The claim went with the priority wait, so nothing is left to hold a ticket gate back from the free slot.
  const ticket = gate(log, "ticket gate");
  await until(() => ticket.held, "the ticket gate's slot");
  ticket.release();
  await ticket.done;
});

// The landing's wiring: the claim begins when the sandbox slot is held and ends with the landing, gated or not.
test("a landing claims the gates pool once it holds its sandbox slot and releases the claim when it ends", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/landing.ts"), "utf8");
  assert.match(src, /const claim = claimSlot\("gates"\);\s+return landInSandbox\([\s\S]*?\)\.finally\(claim\.release\);/);
});
