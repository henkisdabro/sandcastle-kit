// A green gate's want for the run's landing claim (#903) goes once the attempt leaves its gates for a repair or a review, or
// starts another gate run. Kept until the attempt ended, it held every ticket gate back for that whole pass at a gates limit
// of 1, and the ticket's own gates after it (the review after a repair that committed, a forced red's repair) waited behind it
// for ever: a ticket gate yields while the free slots are no more than the run's claims. Through `createSchedule` with the
// run's real `RunClaim` and pool, over test/pool-sim.ts.
//
//   pnpm test:file test/pool-claim-green-regate.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, pool, POLL } from "./pool-sim.ts";

const { createRunClaim, withSlot } = pool;
const { createSchedule } = await import("../src/schedule.ts");
type Landed = import("../src/landing.ts").Landed;
type Attempted = import("../src/schedule.ts").Attempted<{ issue: string }, string>;

afterEach(cleanup);

/** A ticket gate of the run, as `runGates` holds it: green, it tells the claim inside its slot. A hang fails the test. */
const ticketGate = (claim: ReturnType<typeof createRunClaim>, id: string, what: string) =>
  Promise.race([
    withSlot("gates", `${id} ${what}`, async () => claim.greenGate(id), undefined, POLL),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${id}'s ${what} never took the free gates slot`)), 5000).unref()),
  ]);

const runOne = async (steps: (claim: ReturnType<typeof createRunClaim>, at: { juncture(phase: string): Promise<void>; gates?(): void }) => Promise<void>) => {
  const claim = createRunClaim("gates");
  const slot = async (wanted: () => boolean) => (wanted() ? { release: () => {} } : undefined);
  const { endings } = await createSchedule<{ id: string }, { issue: string }, string>({ tickets: [{ id: "A" }] }).run({
    workers: 1,
    concurrency: 1,
    slot,
    claim,
    land: async () => ({ kind: "merged" }) as unknown as Landed,
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
    attempt: async (t, at): Promise<Attempted> => {
      await steps(claim, at);
      return { kind: "green", green: { issue: t.id } };
    },
  });
  return endings.get("A")?.kind;
};

test("a green gate, then the review after a repair that committed: the ticket's own gate run after it takes the free slot", async () => {
  const ending = await runOne(async (claim, at) => {
    await ticketGate(claim, "A", "repair's gate run");
    await at.juncture("review");
    at.gates?.();
    await ticketGate(claim, "A", "gate run after the review");
  });
  assert.equal(ending, "landing");
});

test("a green gate, then a repair pass (a forced red): the ticket's gate run after the repair takes the free slot", async () => {
  const ending = await runOne(async (claim, at) => {
    await ticketGate(claim, "A", "first gate run");
    await at.juncture("repair");
    at.gates?.();
    await ticketGate(claim, "A", "gate run after the repair");
  });
  assert.equal(ending, "landing");
});

test("another gate run of the same attempt, told as gating: an earlier green's want does not hold it back", async () => {
  const ending = await runOne(async (claim, at) => {
    await ticketGate(claim, "A", "first gate run");
    at.gates?.();
    await ticketGate(claim, "A", "second gate run");
  });
  assert.equal(ending, "landing");
});
