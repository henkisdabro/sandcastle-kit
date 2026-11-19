// A paused run with nothing in flight holds no machine-wide sandbox slot, even when a worker waits for a resolve
// that holds every queued ticket (`holdFresh` in src/schedule.ts): it told the pool demand 0, so a slot it kept
// would make another project's ticket wait for the whole pause - a usage pause's whole plan window. The worker
// gives the slot back for the pause and asks the pool again after the resume, and the run ends as it does unpaused.
// Driven through the scheduler's ports with made-up files and fake work. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-pause-held-fresh.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, type TicketFiles } from "../src/schedule.ts";

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
const FILES: Record<string, string> = { 10: "src/a.ts", 20: "src/a.ts", 15: "src/other.ts", 30: "src/a.ts" };
const files = { of: (t: T): TicketFiles => ({ all: [FILES[t.id]!], unmergeable: [] }) };

// Two workers. 10 and 20 start; 10 goes green and conflicts at its landing while 20 is in its gates. 15 holds 10's
// worker until 10 is sent back, so that worker takes 10 again, which goes off to wait for 20. 30 shares a.ts with 10
// and is held for its resolve: the worker 10 left waits for it, with the slot it kept.
test("a paused run with nothing in flight holds no machine-wide sandbox slot", async () => {
  const order: string[] = [];
  const told: Change<G, string>[] = [];
  const inGates = later();
  const run20 = later();
  const sentBack = later();
  let conflicted = false;
  let heldSlots = 0;
  let asked = 0;
  let since: number | undefined;
  const running = createSchedule<T, G, string>({ tickets: ["10", "20", "15", "30"].map((id) => ({ id })), files }).run({
    workers: 2,
    concurrency: 2,
    slot: async () => {
      asked++;
      heldSlots++;
      let gone = false;
      return { release: () => void (gone || ((gone = true), heldSlots--)) };
    },
    pause: { read: () => (since === undefined ? undefined : { since }), pollMs: 5 },
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      try {
        if (t.id === "20") {
          at.gates();
          inGates.open();
          await run20.done;
          return green("20");
        }
        if (t.id === "15") {
          await sentBack.done;
          await sleep(100);
        }
        return green(t.id);
      } finally {
        at.slot?.release();
      }
    },
    land: async (g) => {
      if (g.issue === "10" && !conflicted) {
        await inGates.done;
        conflicted = true;
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      order.push(`land ${g.issue}`);
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      told.push(c);
      if (c.kind === "requeued") sentBack.open();
    },
  });

  await until("30 is held for 10's resolve", () => told.some((c) => c.kind === "resolve holds" && c.id === "30"));
  await until("15 lands", () => order.includes("land 15"));
  since = 1_790_000_000;
  // 20 finishes its gates and lands during the pause, as a pause lets a ticket in flight finish.
  run20.open();
  await until("20 lands", () => order.includes("land 20"));
  await sleep(300);
  const demand = told.filter((c) => c.kind === "demand").at(-1);
  const paused = told.filter((c) => c.kind === "paused").at(-1);
  assert.deepEqual(demand, { kind: "demand", n: 0 });
  assert.deepEqual(paused, { kind: "paused", since: 1_790_000_000, finishing: [] });
  assert.equal(heldSlots, 0, `the paused run told demand 0 but held ${heldSlots} sandbox slot(s); order ${order.join(" | ")}`);
  assert.equal(order.includes("start 10 #2"), false, order.join(" | "));

  const askedBefore = asked;
  since = undefined;
  const { endings } = await running;
  // The resolve and the ticket held for it each ran on a slot asked for after the resume.
  assert.ok(asked > askedBefore, `no slot asked for after the resume (${asked})`);
  assert.ok(order.indexOf("land 20") < order.indexOf("start 10 #2"), order.join(" | "));
  assert.ok(order.indexOf("start 10 #2") < order.indexOf("start 30 #1"), order.join(" | "));
  for (const id of ["10", "15", "20", "30"]) assert.equal(endings.get(id)?.kind, "landing", id);
  assert.equal(heldSlots, 0);
});
