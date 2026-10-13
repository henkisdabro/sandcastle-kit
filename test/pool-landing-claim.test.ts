// A landing that will gate claims the run's gates slot when it holds its sandbox slot, before its gates ask for one: a
// ticket gate asked during the landing's merge yields to it (src/pool.ts `claimSlot`), where it used to take the slot and
// hold it for a whole gate run. The claim yields only while the free gates slots are no more than the run's claims.
//
//   pnpm test:file test/pool-landing-claim.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, pool, POLL, said, steady, until } from "./pool-sim.ts";

const { claimSlot, withSlot } = pool;
type Claim = ReturnType<typeof claimSlot>;

const made: { release: () => void; done: Promise<void> }[] = [];
afterEach(async () => {
  const gates = made.splice(0);
  for (const g of gates) g.release();
  await cleanup();
  await Promise.allSettled(gates.map((g) => g.done));
});

/** One gate of this run asking for the gates pool: it records that it holds a slot, and keeps it until `release()`. `claim`: a landing's, which its priority wait spends. */
const gate = (log: string[], label: string, priority = false, claim?: Claim) => {
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

test("a landing gate asked after a ticket gate, during the landing's merge, still takes the slot first", async () => {
  const log: string[] = [];
  const claim = claimSlot("gates");
  // The landing is merging: a ticket gate asks for the one gates slot, which is free, and leaves it to the landing.
  const ticket = gate(log, "ticket gate");
  await until(() => ticket.waits, "the ticket gate's wait");
  await steady(() => !ticket.held, "the ticket gate left the free slot to the landing's claim", 100);
  assert.ok(said.some((line) => /ticket gate: waiting for a machine-wide gates slot \(a landing, base or verify gate of this run goes first\)/.test(line)), said.join("\n"));

  // The merge is done and the landing gate asks: its wait spends the claim, and it is the one served.
  const landing = gate(log, "landing gate", true, claim);
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
  const holder = gate(log, "holder", true, claimSlot("gates"));
  await until(() => holder.held, "the priority holder's slot");
  holder.release();
  await holder.done;
  // The claim went with the priority wait, so nothing is left to hold a ticket gate back from the free slot.
  const ticket = gate(log, "ticket gate");
  await until(() => ticket.held, "the ticket gate's slot");
  ticket.release();
  await ticket.done;
});

test("a priority wait without a claim (a base or verify gate) leaves a landing's claim standing, so a ticket gate asked after it still waits", async () => {
  const log: string[] = [];
  const claim = claimSlot("gates");
  // The landing is merging. The base check takes the one free slot and finishes.
  const base = gate(log, "base gate", true);
  await until(() => base.held, "the base gate's slot");
  base.release();
  await base.done;
  // The slot is free and a ticket gate asks before the landing does: the claim still holds it back.
  const ticket = gate(log, "ticket gate");
  await until(() => ticket.waits, "the ticket gate's wait");
  await steady(() => !ticket.held, "the ticket gate left the free slot to the landing's claim", 100);
  // The landing's own priority wait is served first, and only then the ticket gate.
  const landing = gate(log, "landing gate", true, claim);
  await until(() => landing.held, "the landing gate's slot");
  assert.equal(ticket.held, false);
  landing.release();
  await until(() => ticket.held, "the ticket gate's slot, once the landing gate is done");
  claim.release();
  ticket.release();
  await Promise.all([ticket.done, landing.done]);
  assert.deepEqual(log, ["base gate", "landing gate", "ticket gate"]);
});

test("a landing's priority wait ends only its own claim: another landing's still holds ticket gates back", async () => {
  const log: string[] = [];
  const older = claimSlot("gates");
  const newer = claimSlot("gates");
  // The newer landing gates and finishes: its wait spends its claim, and releasing it afterwards ends nothing else.
  const landing = gate(log, "newer landing gate", true, newer);
  await until(() => landing.held, "the newer landing gate's slot");
  landing.release();
  await landing.done;
  newer.release();
  const ticket = gate(log, "ticket gate");
  await until(() => ticket.waits, "the ticket gate's wait");
  await steady(() => !ticket.held, "the ticket gate left the free slot to the older landing's claim", 100);
  older.release();
  await until(() => ticket.held, "the ticket gate's slot, once the older claim ends");
  ticket.release();
  await ticket.done;
});
