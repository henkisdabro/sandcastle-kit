// The run holds one gates claim from the moment a green branch is queued to land (src/pool.ts `createRunClaim`, told by
// `createLanding`, src/schedule.ts), not from the moment a landing holds its sandbox slot: in the seconds between one landing's
// end and the next one's sandbox, a ticket gate of the run took the free gates slot and every landing's gates waited out one
// ticket-gate run. Gates limit 1, through test/pool-sim.ts; the limit-2 cases are test/pool-landing-claim-queued-spare.test.ts.
//
//   pnpm test:file test/pool-landing-claim-queued.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, pool, POLL, steady, until } from "./pool-sim.ts";

const { createRunClaim, withSlot } = pool;
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
 * `gateEnded`) unless `skip` has it; its gate holds the slot until `gates[n].open()`, and the landing itself ends at `ends[n].open()`.
 */
const queue = (log: string[], skip: (issue: string) => boolean = () => false) => {
  const claim = createRunClaim("gates");
  const stop = createStopState();
  const gates: Record<string, ReturnType<typeof gateway>> = {};
  const ends: Record<string, ReturnType<typeof gateway>> = {};
  const gateOf = (n: string) => (gates[n] ??= gateway());
  const endOf = (n: string) => (ends[n] ??= gateway());
  const ports: Port = {
    claim,
    host: { check: async () => {}, failed: undefined },
    land: async (g) => {
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
  return { landing, stop, gate: gateOf, end: endOf };
};

test("a landing's gates take the slot before a ticket gate that waited since the branches were queued", async () => {
  const log: string[] = [];
  const q = queue(log);
  q.landing.push({ issue: "1" });
  q.landing.push({ issue: "2" });
  const ticket = ticketGate(log);
  // The worker starts only now: no landing holds anything yet, and the run's claim already keeps the free slot from the ticket.
  await steady(() => !ticket.held, "the ticket gate left the free slot to the queued landings", 60);
  const running = q.landing.run();
  await until(() => log.includes("landing 1"), "landing 1's gates");
  q.gate("1").open();
  q.end("1").open();
  await until(() => log.includes("landing 2"), "landing 2's gates");
  assert.equal(ticket.held, false);
  q.gate("2").open();
  q.end("2").open();
  q.landing.close();
  await running;
  await until(() => ticket.held, "the ticket gate's slot, once no landing is left");
  assert.deepEqual(log, ["landing 1", "landing 2", "ticket"]);
  ticket.open();
  await ticket.done;
});

test("a ticket gate asked after the first landing's gates ended, while it finishes, still waits for the second landing's gates", async () => {
  const log: string[] = [];
  const q = queue(log);
  q.landing.push({ issue: "1" });
  q.landing.push({ issue: "2" });
  const running = q.landing.run();
  await until(() => log.includes("landing 1"), "landing 1's gates");
  q.gate("1").open();
  // Landing 1's gates are over but the landing is not: its fast-forward and close run, and the gap is the one the ticket used to win.
  const ticket = ticketGate(log);
  await steady(() => !ticket.held, "the ticket gate left the slot the first gate run freed to the second landing", 60);
  q.end("1").open();
  await until(() => log.includes("landing 2"), "landing 2's gates");
  assert.equal(ticket.held, false);
  q.gate("2").open();
  q.end("2").open();
  q.landing.close();
  await running;
  await until(() => ticket.held, "the ticket gate");
  assert.deepEqual(log, ["landing 1", "landing 2", "ticket"]);
  ticket.open();
  await ticket.done;
});

test("a stop while a green is queued releases the claim: a waiting ticket gate takes the free slot", async () => {
  const log: string[] = [];
  const q = queue(log);
  q.landing.push({ issue: "1" });
  const ticket = ticketGate(log);
  await steady(() => !ticket.held, "the ticket gate waited while a green was queued", 60);
  q.stop.add({ kind: "tampered", error: new Error("the .git check failed") });
  await until(() => ticket.held, "the ticket gate's slot, once the stop released the claim");
  ticket.open();
  await ticket.done;
});

test("a stop during a landing's gate run: nothing claims again when that gate ends, and the ticket gate takes the slot before the landing finishes", async () => {
  const log: string[] = [];
  const q = queue(log);
  q.landing.push({ issue: "1" });
  const running = q.landing.run();
  await until(() => log.includes("landing 1"), "landing 1's gates");
  q.landing.push({ issue: "2" });
  const ticket = ticketGate(log);
  await steady(() => !ticket.held, "the ticket gate waited for the slot landing 1's gates hold", 60);
  q.stop.add({ kind: "tampered", error: new Error("the .git check failed") });
  q.gate("1").open();
  // Landing 1 is not over (`end("1")` is closed): the freed slot is the ticket's, with a green still queued.
  await until(() => ticket.held, "the ticket gate's slot as landing 1's gates end");
  q.end("1").open();
  q.landing.close();
  await running;
  assert.deepEqual(log, ["landing 1", "ticket", "stopped 2"]);
  ticket.open();
  await ticket.done;
});

test("a last landing that ends without gating releases the claim", async () => {
  const log: string[] = [];
  const q = queue(log, () => true);
  q.landing.push({ issue: "1" });
  const running = q.landing.run();
  const ticket = ticketGate(log);
  await steady(() => !ticket.held, "the ticket gate waited while the landing was in flight", 60);
  q.end("1").open();
  q.landing.close();
  await running;
  await until(() => ticket.held, "the ticket gate's slot, once the landing ended without gating");
  assert.deepEqual(log, ["ticket"]);
  ticket.open();
  await ticket.done;
});

test("the burndown's landing ports keep the run's claim", async () => {
  const { readFileSync } = await import("node:fs");
  // `burndown()` needs Docker, so no test drives it: its landing ports are `landingWork`'s, spread whole, `claim` included.
  assert.match(readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8"), /const landings: typeof landingPorts = \{\s*\.\.\.landingPorts,/);
  assert.match(readFileSync(new URL("../src/landing.ts", import.meta.url), "utf8"), /portsOver = \(ctx: LandContext, claim: RunClaim\)/);
});
