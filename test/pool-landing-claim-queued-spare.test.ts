// The run's one gates claim (src/pool.ts `createRunClaim`) with `maxGates` 2: while a landing's gate run holds a slot no claim stands
// for the branches queued behind it, so a ticket gate takes the spare slot at once, and the slot that gate run frees goes to the
// next landing before a ticket gate. Its own file: the pool reads its gates limit once, and test/pool-landing-claim-queued.test.ts needs 1.
//
//   pnpm test:file test/pool-landing-claim-queued-spare.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, pool, POLL, sleep, steady, until } from "./pool-sim.ts";

// Before the pool first reads its gates limit, which it keeps.
process.env.SANDCASTLE_MAX_GATES = "2";
const { createRunClaim, limit, withSlot } = pool;
const { createLanding, createStopState } = await import("../src/schedule.ts");
type Landed = import("../src/landing.ts").Landed;
type Port = import("../src/schedule.ts").LandPorts<{ issue: string }>;

const finish: (() => void)[] = [];
afterEach(async () => {
  for (const f of finish.splice(0)) f();
  await cleanup();
});

/** A promise the test settles by hand. */
const gateway = () => {
  let open!: () => void;
  const done = new Promise<void>((r) => (open = r));
  finish.push(open);
  return { done, open };
};

/** A ticket gate of the run: a plain wait for the gates pool, holding the slot until `open()`. */
const ticketGate = (log: string[]) => {
  const hold = gateway();
  const t = { held: false, open: hold.open, done: undefined as unknown as Promise<void> };
  t.done = withSlot("gates", "ticket", async () => {
    t.held = true;
    log.push("ticket");
    await hold.done;
  }, undefined, POLL);
  return t;
};

/**
 * The landing queue over a fake land port. Landing `n` gates the way `landOne` does (`take`, a priority wait that spends the claim,
 * `gateEnded`) unless `skip` has it, after `merge(n)` opens for the ones in `before`; its gate holds the slot until `gates[n].open()`, and the landing itself ends at `ends[n].open()`.
 */
const queue = (log: string[], skip: (issue: string) => boolean = () => false, before: string[] = []) => {
  const claim = createRunClaim("gates");
  const stop = createStopState();
  const gates: Record<string, ReturnType<typeof gateway>> = {};
  const ends: Record<string, ReturnType<typeof gateway>> = {};
  const gateOf = (n: string) => (gates[n] ??= gateway());
  const merges: Record<string, ReturnType<typeof gateway>> = {};
  const mergeOf = (n: string) => (merges[n] ??= gateway());
  const endOf = (n: string) => (ends[n] ??= gateway());
  const ports: Port = {
    claim,
    host: { check: async () => {}, failed: undefined },
    land: async (g) => {
      // `before`: a landing still merging, which has not begun its gate run.
      if (before.includes(g.issue)) await mergeOf(g.issue).done;
      if (!skip(g.issue)) {
        const handed = claim.take();
        try {
          await withSlot("gates", `landing ${g.issue}`, async () => {
            log.push(`landing ${g.issue}`);
            await gateOf(g.issue).done;
          }, undefined, POLL, true, false, undefined, handed);
        } finally {
          handed?.release();
          claim.gateEnded();
        }
      }
      await endOf(g.issue).done;
      return { kind: "merged" } as unknown as Landed;
    },
  };
  const landing = createLanding(ports, stop, { settled: () => {}, stopped: (g) => void log.push(`stopped ${g.issue}`) });
  return { landing, stop, gate: gateOf, end: endOf, merge: mergeOf };
};

test("while a landing's gates run and a second green is queued, a ticket gate takes the spare slot; the freed slot goes to the second landing first", async () => {
  assert.equal(limit("gates"), 2);
  const log: string[] = [];
  const q = queue(log);
  q.landing.push({ issue: "1" });
  const running = q.landing.run();
  await until(() => log.includes("landing 1"), "landing 1's gates");
  // Queued during landing 1's gate run: not claimed at the push, so the spare slot is free for a ticket gate.
  q.landing.push({ issue: "2" });
  const spare = ticketGate(log);
  await until(() => spare.held, "the ticket gate's spare slot");
  const waiting = ticketGate(log);
  await steady(() => !waiting.held, "the second ticket gate waited: both slots are taken", 60);
  // Landing 1's gate run ends: the run claims for landing 2 before the slot is free, so the ticket gates yield to it.
  q.gate("1").open();
  q.end("1").open();
  await until(() => log.includes("landing 2"), "landing 2's gates");
  assert.equal(waiting.held, false);
  spare.open();
  q.gate("2").open();
  q.end("2").open();
  q.landing.close();
  await running;
  await until(() => waiting.held, "the waiting ticket gate, once landing 2's gates are done");
  assert.deepEqual(log, ["landing 1", "ticket", "landing 2", "ticket"]);
  waiting.open();
  await Promise.all([waiting.done, spare.done]);
});

test("a landing that ends without gating, with another green queued, leaves exactly one claim standing", async () => {
  const log: string[] = [];
  const q = queue(log, (issue) => issue === "1", ["2"]);
  q.landing.push({ issue: "1" });
  q.landing.push({ issue: "2" });
  const running = q.landing.run();
  // Landing 1 ends at once, without gating; landing 2 is taken off the queue.
  q.end("1").open();
  await sleep(10);
  // Landing 2 is in flight, not yet gating: its claim is the run's one. One slot held by a ticket gate leaves one free, which a claim keeps...
  const holder = ticketGate(log);
  await until(() => holder.held, "a ticket gate on the free slot");
  const behind = ticketGate(log);
  await steady(() => !behind.held, "the free slot stays with the landing's claim", 60);
  // ...and with a second slot freed the claims (one) are fewer than the free slots, so a ticket gate goes on: not two claims.
  holder.open();
  await until(() => behind.held, "a ticket gate on the spare slot, with one claim and two slots free");
  assert.deepEqual(log, ["ticket", "ticket"]);
  behind.open();
  q.merge("2").open();
  q.gate("2").open();
  q.end("2").open();
  q.landing.close();
  await running;
  await Promise.all([holder.done, behind.done]);
});
