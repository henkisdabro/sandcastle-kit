// A resolve about to be released holds one worker, not every worker that comes free: the others take the queue's
// fresh tickets. And a ticket that leaves its gates for a repair no longer holds a resolve that shares its files: a
// repair can take an hour (createSchedule in src/schedule.ts). Driven through the scheduler's ports with made-up
// files and fake work. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-resolve-one-holder.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import { type Attempted, createSchedule, type TicketFiles } from "../src/schedule.ts";

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
const SHARED: Record<string, string> = { 10: "src/a.ts", 20: "src/a.ts", 30: "src/c.ts", 40: "src/d.ts", 50: "src/e.ts" };
const files = { of: (t: T): TicketFiles => ({ all: [SHARED[t.id]!], unmergeable: [] }) };

test("a second worker freed while a resolve is about to be released takes a fresh ticket, not a second hold", async () => {
  // Three workers. 10 conflicts at its landing while 20 (same file) is in its gates, and 40 takes 10's worker. Once 20 is
  // green and landing, 20's worker holds for 10's resolve; 30's worker, freed next, takes 50 rather than holding too.
  const order: string[] = [];
  const gatesDone = later();
  const inGates = later();
  const land20 = later();
  const hold30 = later();
  const hold40 = later();
  const requeued = later();
  let conflicted = false;
  const running = createSchedule<T, G, string>({ tickets: ["10", "20", "30", "40", "50"].map((id) => ({ id })), files }).run({
    workers: 3,
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (t.id === "20") {
        at.gates();
        inGates.open();
        await gatesDone.done;
      }
      if (t.id === "30") await hold30.done;
      if (t.id === "40") await hold40.done;
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
    tell: (c) => void (c.kind === "requeued" && requeued.open()),
  });
  await requeued.done;
  await until("40 takes 10's worker while 20 is in its gates", () => order.includes("start 40 #1"));
  gatesDone.open();
  await until("20 queued to land", () => order.includes("landing 20"));
  hold30.open();
  await until("30's worker takes 50 while 20's worker holds for the resolve", () => order.includes("start 50 #1"));
  assert.equal(order.includes("land 20"), false, order.join(" | "));
  land20.open();
  await until("the resolve starts", () => order.includes("start 10 #2"));
  hold40.open();
  const { endings } = await running;
  assert.ok(order.indexOf("land 20") < order.indexOf("start 10 #2"), order.join(" | "));
  for (const id of ["10", "20", "30", "40", "50"]) assert.equal(endings.get(id)?.kind, "landing", id);
});

test("a ticket that leaves its gates for a repair no longer holds a resolve that shares its files", async () => {
  // Two workers. 10 conflicts at its landing while 20 is in its gates; 20 then goes red and into a repair, which the
  // resolve of 10 does not wait out: 10 starts again while 20 is still repairing.
  const order: string[] = [];
  const inGates = later();
  const toRepair = later();
  const repairDone = later();
  let conflicted = false;
  const running = createSchedule<T, G, string>({ tickets: [{ id: "10" }, { id: "20" }], files }).run({
    workers: 2,
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (t.id === "20") {
        at.gates();
        inGates.open();
        await toRepair.done;
        await at.juncture("repair");
        order.push("repairing 20");
        await repairDone.done;
        at.gates();
      }
      return green(t.id);
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
    tell: (c) => void (c.kind === "requeued" && toRepair.open()),
  });
  await until("20 repairing", () => order.includes("repairing 20"));
  await until("10's resolve starts while 20 repairs", () => order.includes("start 10 #2"));
  assert.equal(order.includes("land 20"), false, order.join(" | "));
  repairDone.open();
  const { endings } = await running;
  for (const id of ["10", "20"]) assert.equal(endings.get(id)?.kind, "landing", id);
});
