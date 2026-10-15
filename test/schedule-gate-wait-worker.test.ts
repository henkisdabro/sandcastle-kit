// A ticket whose sandbox only waits for a gates slot frees its worker (createSchedule in src/schedule.ts): the attempt
// says so (`at.gateWait`), its container lives on an uncounted lock (src/pool.ts `uncountSlot`), and the worker begins the
// next ticket while the attempt goes on off it. At most `gateWaiters` attempts wait so at once. A ticket that then needs a
// counted slot (a repair pass) asks for it again (`at.retake`), served as a worker's ask - ahead of tickets that have not
// started, behind a landing - and never has more agent passes running than workers. Driven through the scheduler's ports with
// a fake counted-slot pool and fake work. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-gate-wait-worker.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createGateSeat } from "../src/burndown.ts";
import type { Landed } from "../src/landing.ts";
import { type Attempted, createSchedule, type Slot, type TicketFiles } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const later = () => {
  let open!: () => void;
  const done = new Promise<void>((resolve) => (open = resolve));
  return { done, open };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), `timed out waiting for ${what}`);
};
const steady = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 20; i++) {
    assert.ok(ok(), what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const filesOf = (by: Record<string, string[]>) => ({ of: (t: T): TicketFiles => ({ all: by[t.id] ?? [], unmergeable: [] }) });
const MERGED: Landed = { kind: "merged" };

/** A counted pool of `capacity` sandbox slots; a landing's ask (`landing.waiting`) goes before a worker's, as `slotTurn` does. */
const countedPool = (capacity: number) => {
  let free = capacity;
  const pool = {
    free: () => free,
    landings: 0,
    take: (): Slot => {
      free--;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          free++;
        },
      };
    },
    slot: async (wanted: () => boolean): Promise<Slot | undefined> => {
      for (;;) {
        if (!wanted()) return undefined;
        if (free > 0 && pool.landings === 0) return pool.take();
        await tick();
      }
    },
    /** A landing leases a slot (first in line), runs `fn`, frees it. */
    landing: async <R>(fn: () => Promise<R> | R): Promise<R> => {
      pool.landings++;
      while (free === 0) await tick();
      pool.landings--;
      const slot = pool.take();
      try {
        return await fn();
      } finally {
        slot.release();
      }
    },
  };
  return pool;
};

/** What burndown's attempt does at a gates wait: tells the scheduler, and frees the counted slot it moves off the count. */
const moveOff = (at: { gateWait(): boolean; slot?: Slot }, uncounted: Set<string>, id: string) => {
  if (!at.gateWait()) return false;
  uncounted.add(id);
  at.slot?.release();
  return true;
};

const run = (tickets: string[], work: Partial<Parameters<ReturnType<typeof createSchedule<T, G, string>>["run"]>[0]> & Pick<Parameters<ReturnType<typeof createSchedule<T, G, string>>["run"]>[0], "attempt">, plan: Partial<Parameters<typeof createSchedule<T, G, string>>[0]> = {}) =>
  createSchedule<T, G, string>({ tickets: tickets.map((id) => ({ id })), ...plan }).run({
    workers: 1,
    concurrency: 1,
    gateWaiters: 1,
    land: async () => MERGED,
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
    ...work,
  });

test("a ticket that waits for a gates slot on an uncounted lock frees its worker: the next ticket begins before it ends, and it lands without leasing a slot", async () => {
  const order: string[] = [];
  const gates = later();
  const counted = countedPool(1);
  const uncounted = new Set<string>();
  const { endings } = await run(["10", "20"], {
    slot: async (wanted) => {
      const slot = await counted.slot(wanted);
      if (slot) order.push("lease");
      return slot;
    },
    attempt: async (t, at) => {
      order.push(`start ${t.id}`);
      if (t.id === "10") {
        at.gates();
        assert.equal(moveOff(at, uncounted, t.id), true);
        await gates.done;
        order.push("end 10");
        uncounted.delete(t.id);
        return green(t.id);
      }
      gates.open();
      at.slot?.release();
      order.push("end 20");
      return green(t.id);
    },
    land: async (g) => {
      order.push(`land ${g.issue}`);
      return MERGED;
    },
  });
  assert.deepEqual(order, ["lease", "start 10", "lease", "start 20", "end 20", "end 10", "land 20", "land 10"], "a green ticket asks for no slot after its gates");
  assert.equal(endings.get("10")?.kind, "landing");
  assert.equal(endings.get("20")?.kind, "landing");
  assert.equal(counted.free(), 1, "every counted slot is back");
});

test("with the cap at 1, a second ticket that reaches its gates wait keeps its worker: the third does not begin until it ends", async () => {
  const order: string[] = [];
  const hold = later();
  const counted = countedPool(3);
  const uncounted = new Set<string>();
  const running = run(["10", "20", "30"], {
    concurrency: 3,
    slot: counted.slot,
    attempt: async (t, at) => {
      order.push(`start ${t.id}`);
      if (t.id === "10") {
        assert.equal(moveOff(at, uncounted, t.id), true);
        await hold.done;
      }
      if (t.id === "20") {
        assert.equal(moveOff(at, uncounted, t.id), false, "the cap is spent: it keeps its slot and its worker");
        await hold.done;
      }
      at.slot?.release();
      order.push(`end ${t.id}`);
      return green(t.id);
    },
  });
  await until(() => order.includes("start 20"), "the second ticket to begin");
  await steady(() => !order.includes("start 30"), "the third waits for the worker the second holds");
  hold.open();
  await running;
  assert.ok(order.indexOf("end 20") < order.indexOf("start 30"), order.join(" | "));
});

test("a ticket whose gates go red leases a counted slot again before its repair: after the pass running, ahead of a new ticket, and the uncounted lock goes once it holds it", async () => {
  const order: string[] = [];
  const passB = later();
  const counted = countedPool(1);
  const uncounted = new Set<string>();
  const running = run(["A", "B", "C"], {
    slot: counted.slot,
    attempt: async (t, at) => {
      order.push(`start ${t.id}`);
      if (t.id === "A") {
        const seat = createGateSeat({
          gateWait: at.gateWait,
          retake: at.retake,
          uncount: (lease) => {
            uncounted.add("A");
            lease.release();
            return { release: () => void uncounted.delete("A") };
          },
        });
        assert.equal(seat.move(at.slot!), true);
        assert.deepEqual([...uncounted], ["A"]);
        // Red, as B starts implementing on the slot A freed.
        await until(() => order.includes("start B"), "B to start");
        order.push("A red");
        const taken = await seat.retake();
        assert.equal(uncounted.size, 0, "the uncounted lock is gone once the counted slot is held");
        order.push("A repair");
        assert.equal(counted.free(), 0, "the repair holds the one counted slot");
        taken!.slot!.release();
        return green(t.id);
      }
      if (t.id === "B") {
        await passB.done;
        order.push("B pass ends");
      }
      at.slot?.release();
      return green(t.id);
    },
  });
  await until(() => order.includes("A red"), "A to go red");
  await steady(() => !order.includes("A repair"), "A's repair waits for B's pass: one worker, one agent pass");
  passB.open();
  await running;
  assert.deepEqual(order, ["start A", "start B", "A red", "B pass ends", "A repair", "start C"]);
});

test("a landing waiting for a sandbox slot goes before a ticket's retake", async () => {
  const order: string[] = [];
  const passB = later();
  const counted = countedPool(1);
  const uncounted = new Set<string>();
  const running = run(["A", "B"], {
    slot: counted.slot,
    landingWaits: () => counted.landings > 0,
    attempt: async (t, at) => {
      if (t.id === "A") {
        assert.equal(moveOff(at, uncounted, t.id), true);
        await until(() => order.includes("start B"), "B to start");
        const taken = await at.retake();
        order.push("A repair");
        taken!.slot!.release();
        return green(t.id);
      }
      order.push("start B");
      await passB.done;
      at.slot?.release();
      return green(t.id);
    },
  });
  await until(() => order.includes("start B"), "B to start");
  // A landing of the run waits for a slot, as B's pass ends.
  counted.landings++;
  passB.open();
  await until(() => counted.free() === 1, "B's slot to be free");
  await steady(() => !order.includes("A repair"), "the free slot is the landing's, not the retake's");
  counted.landings--;
  order.push("landing");
  const landing = counted.take();
  await steady(() => !order.includes("A repair"), "the landing holds the slot");
  landing.release();
  await running;
  assert.deepEqual(order, ["start B", "landing", "A repair"]);
});

test("a retake during a pause is declined, and served after the resume", async () => {
  const counted = countedPool(1);
  const uncounted = new Set<string>();
  let paused = false;
  const answers: string[] = [];
  await run(["A"], {
    slot: counted.slot,
    pause: { read: () => (paused ? { since: 1 } : undefined), pollMs: 5 },
    attempt: async (t, at) => {
      assert.equal(moveOff(at, uncounted, t.id), true);
      paused = true;
      answers.push((await at.retake()) === undefined ? "declined" : "served");
      paused = false;
      const taken = await at.retake();
      answers.push(taken?.slot ? "served" : "declined");
      taken?.slot?.release();
      return green(t.id);
    },
  });
  assert.deepEqual(answers, ["declined", "served"]);
  assert.equal(counted.free(), 1);
});

test("a ticket that moved off its worker is still in its gates for a resolve that shares its files, until its gates end", async () => {
  const order: string[] = [];
  const gatesEnd = later();
  const counted = countedPool(1);
  const uncounted = new Set<string>();
  const first = { landed: false };
  const { endings } = await run(["20", "10"], {
    slot: counted.slot,
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (t.id === "20") {
        at.gates();
        assert.equal(moveOff(at, uncounted, t.id), true);
        await gatesEnd.done;
        order.push("end 20");
        return green(t.id);
      }
      at.slot?.release();
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && !first.landed) {
        first.landed = true;
        order.push("land 10 conflict");
        // 20 is on the uncounted lock with its worker gone, and still in its gates: 10's resolve waits for it.
        setTimeout(() => gatesEnd.open(), 100);
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      order.push(`land ${g.issue}`);
      return MERGED;
    },
  }, { files: filesOf({ 10: ["src/a.ts"], 20: ["src/a.ts"] }) });
  assert.ok(order.indexOf("land 10 conflict") < order.indexOf("end 20"), order.join(" | "));
  assert.ok(order.indexOf("land 20") < order.indexOf("start 10 #2"), `10's resolve waited for 20: ${order.join(" | ")}`);
  assert.equal(endings.get("10")?.kind, "landing");
});

test("source: a ticket gate's wait for a gates slot moves the lease off the count, in burndown's wait callback and attempt", () => {
  // burndown() needs Docker, so no test drives it: its wiring is held by its source.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /if \(!priority\) gateWaits\.get\(id\)\?\.\(\);/);
  assert.match(src, /gateWaits\.set\(issue\.id, \(\) => \{\s*if \(lease && seat\.move\(lease\)\) lease = undefined;/);
  assert.match(src, /const seat = createGateSeat\(\{ gateWait, retake, uncount: \(l\) => uncountSlot\(l, /);
  assert.match(src, /agent: counted, paused, gates, resolveWaitMs \}\)/);
  assert.match(src, /gateWaiters: limit\("gates"\), attempt,/);
  assert.equal(src.match(/await at\?\.agent\?\.\(\);/g)?.length, 2, "before the repair pass and before the review after it");
});
