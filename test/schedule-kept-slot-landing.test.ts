// A worker whose ticket went off to wait for its resolve keeps its sandbox slot (slot first, createSchedule in
// src/schedule.ts), and took the queue's next ticket in it at once: a landing waiting for a sandbox - the one the
// resolve waits for - then waited out that ticket's whole pipeline, never reaching `slotTurn`, where an attempt
// yields to it. With a landing waiting (`Work.landingWaits`), the kept slot goes back and the worker asks again.
// One worker and one sandbox slot, the slot port's own; fake attempts and landings. No git, no Docker, no network.
//
//   node --test test/schedule-kept-slot-landing.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { slotTurn } from "../src/landing.ts";
import { type Change, createSchedule, type Slot, type TicketFiles } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const later = () => {
  let open!: () => void;
  const done = new Promise<void>((resolve) => (open = resolve));
  return { done, open };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

/** One sandbox slot: `take` waits until it is free. */
const oneSlot = () => {
  let holder: string | undefined;
  return {
    holder: () => holder,
    take: async (who: string): Promise<Slot> => {
      while (holder !== undefined) await tick();
      holder = who;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          holder = undefined;
        },
      };
    },
  };
};

test("a landing waiting for a sandbox takes a worker's kept slot before the next queued ticket starts", async () => {
  const order: string[] = [];
  const told: Change<G, string>[] = [];
  const pool = oneSlot();
  // Landings waiting for a sandbox slot, as burndown's `slotWanted`.
  const wanted = { n: 0 };
  const twentyStarted = later();
  const requeued = later();
  // Opened once the worker has the slot it will take 10's second attempt in: 20's landing then asks for one.
  const askForSandbox = later();
  let slots = 0;
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }, { id: "30" }],
    files: { of: (t: T): TicketFiles => ({ all: t.id === "30" ? ["src/c.ts"] : ["src/a.ts"], unmergeable: [] }) },
  });
  const { endings } = await schedule.run({
    workers: 1,
    landingWaits: () => wanted.n > 0,
    slot: async () => {
      await slotTurn(wanted, 2);
      const slot = await pool.take("ticket");
      // The third lease, after 20's attempt: granted just as 20's landing began to want a sandbox.
      if (++slots === 3) {
        askForSandbox.open();
        while (wanted.n === 0) await tick();
      }
      return slot;
    },
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      try {
        if (t.id === "20") {
          twentyStarted.open();
          await requeued.done;
        }
        return { kind: "green", green: { issue: t.id } };
      } finally {
        at.slot?.release();
      }
    },
    land: async (g) => {
      // 10 collides with 20's files while 20 is still in its pipeline: sent back, it resolves after 20 lands.
      if (g.issue === "10" && !told.some((c) => c.kind === "requeued")) {
        await twentyStarted.done;
        return { kind: "conflict", files: ["src/a.ts"], with: [] };
      }
      if (g.issue === "20") {
        await askForSandbox.done;
        wanted.n++;
        const slot = await pool.take("landing");
        wanted.n--;
        order.push("land 20 in a sandbox");
        slot.release();
      }
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      told.push(c);
      if (c.kind === "requeued") requeued.open();
    },
  });
  assert.ok(order.indexOf("land 20 in a sandbox") >= 0, order.join(" | "));
  assert.ok(order.indexOf("land 20 in a sandbox") < order.indexOf("start 30 #1"), order.join(" | "));
  // 10's resolve, freed by that landing, still goes before the ticket queued behind it.
  assert.ok(order.indexOf("start 10 #2") < order.indexOf("start 30 #1"), order.join(" | "));
  for (const id of ["10", "20", "30"]) assert.equal(endings.get(id)?.kind, "landing", id);
  assert.equal(pool.holder(), undefined, "the run holds no slot once it has ended");
});

test("the run's schedule is told when a landing waits for a sandbox slot", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.ok(/\.run\(\{[^\n]*landingWaits: \(\) => slotWanted\.n > 0[^\n]*\}\)/.test(source), "burndown's schedule.run passes landingWaits");
});
