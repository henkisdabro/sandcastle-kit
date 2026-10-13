// A sent-back ticket's resolve is released before a ticket that has not started: the worker that frees
// while the branch it waits for lands leaves the queue's fresh tickets until the resolve has been
// released, unless a ticket in its gates still holds it; and the resolve's recorded wait runs from its
// requeue to its start (createSchedule in src/schedule.ts, burndown.ts for the note). Driven through the
// scheduler's ports with made-up files and fake work. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-resolve-first.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, RESOLVE_SETTLE_MS, type TicketFiles } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const later = () => {
  let open!: () => void;
  const done = new Promise<void>((resolve) => (open = resolve));
  return { done, open };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await sleep(20);
  assert.ok(ok(), what);
};

// Two workers. 10 and 20 share a.ts, 30 and 40 are alone. 10 goes green first and conflicts at its landing while 20 is in
// its gates; 30 holds one worker for good; the other takes 10 again once 20's worker frees, so 10 waits for 20, and 40 is
// the fresh ticket that worker would take next.
const play = (opts: { clock?: { now: number } } = {}) => {
  const order: string[] = [];
  const told: Change<G, string>[] = [];
  const resolveWaitMs: Record<string, number | undefined> = {};
  const gatesDone = later();
  const holdThirty = later();
  const land20 = later();
  const requeued = later();
  const inGates = later();
  let conflicted = false;
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }, { id: "30" }, { id: "40" }],
    files: { of: (t: T): TicketFiles => ({ all: [{ 10: "src/a.ts", 20: "src/a.ts", 30: "src/c.ts", 40: "src/d.ts" }[t.id as "10"]], unmergeable: [] }) },
  });
  const running = schedule.run({
    workers: 2,
    ...(opts.clock && { now: () => opts.clock!.now }),
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (at.n === 2) resolveWaitMs[t.id] = at.resolveWaitMs;
      if (t.id === "20") {
        at.gates();
        inGates.open();
        await gatesDone.done;
      }
      if (t.id === "30") await holdThirty.done;
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && !conflicted) {
        await inGates.done;
        conflicted = true;
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      if (g.issue === "20") {
        order.push("landing 20");
        await land20.done;
      }
      order.push(`land ${g.issue}`);
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      told.push(c);
      if (c.kind === "requeued") requeued.open();
    },
  });
  return { order, told, resolveWaitMs, running, gatesDone, holdThirty, land20, requeued };
};

test("a worker freed while the branch a resolve waits for lands takes the resolve before a ticket that has not started", async () => {
  const p = play();
  await p.requeued.done;
  p.gatesDone.open();
  await until("20 queued to land", () => p.order.includes("landing 20"));
  // 20's worker is free and 40, which has not started, is queued: the resolve of 10 goes first.
  await sleep(200);
  assert.equal(p.order.includes("start 40 #1"), false, p.order.join(" | "));
  assert.equal(p.order.includes("start 10 #2"), false, p.order.join(" | "));
  p.land20.open();
  p.holdThirty.open();
  const { endings } = await p.running;
  assert.ok(p.order.indexOf("start 10 #2") < p.order.indexOf("start 40 #1"), p.order.join(" | "));
  assert.ok(p.order.indexOf("land 20") < p.order.indexOf("start 10 #2"), p.order.join(" | "));
  for (const id of ["10", "20", "30", "40"]) assert.equal(endings.get(id)?.kind, "landing", id);
});

test("a worker goes on to a ticket that has not started while the resolve is held by a ticket still in its gates", async () => {
  const p = play();
  // 30 leaves its worker to 10 as soon as 10 is sent back; 20 stays in its gates.
  await p.requeued.done;
  p.holdThirty.open();
  await until("40 to start while 20 is in its gates", () => p.order.includes("start 40 #1"));
  assert.equal(p.order.includes("start 10 #2"), false, p.order.join(" | "));
  p.gatesDone.open();
  p.land20.open();
  const { endings } = await p.running;
  assert.ok(p.order.indexOf("land 20") < p.order.indexOf("start 10 #2"), p.order.join(" | "));
  for (const id of ["10", "20", "30", "40"]) assert.equal(endings.get(id)?.kind, "landing", id);
});

test("a resolve's recorded wait runs from its requeue to its start, and its note says it waits for a free slot once the wait is over", async () => {
  const clock = { now: 1_000 };
  const p = play({ clock });
  await p.requeued.done;
  // Queued for a worker, with none free yet: no part of the wait loop, all of the wait.
  clock.now += 60_000;
  p.gatesDone.open();
  await until("20 queued to land", () => p.order.includes("landing 20"));
  clock.now += RESOLVE_SETTLE_MS;
  await until("the wait is said", () => p.told.some((c) => c.kind === "resolve waits"));
  clock.now += 30_000;
  p.land20.open();
  p.holdThirty.open();
  await p.running;
  assert.equal(p.resolveWaitMs["10"], 60_000 + RESOLVE_SETTLE_MS + 30_000);
  const kinds = p.told.flatMap((c) => (c.kind === "resolve waits" || c.kind === "resolve queued" || c.kind === "resolve starts" ? [c.kind] : []));
  assert.deepEqual(kinds, ["resolve waits", "resolve queued", "resolve starts"]);
});

test("the run's record gives a resolve that waits for a free slot its own note", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /case "resolve queued":\n\s+run\.ticket\(c\.id, \{ note: "waits for a free slot to resolve its conflict" \}\);/);
  assert.match(source, /case "resolve queued":\n\s+return holds\.tell\(run, c\);/);
});
