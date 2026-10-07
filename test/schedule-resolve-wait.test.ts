// A ticket sent back after a conflict at landing resolves it once the green branches that share
// its files have landed (createSchedule in src/schedule.ts), so none of them conflicts with the
// resolve again; and a second conflict that a landing caused after the resolve began is a new
// requeue, not a final "conflicted again". Driven through the scheduler's ports with made-up
// files and fake work. No git, no Docker, no network.
//
//   node --test test/schedule-resolve-wait.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, type TicketFiles } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const later = () => {
  let open!: () => void;
  const done = new Promise<void>((resolve) => (open = resolve));
  return { done, open };
};
const filesOf = (by: Record<string, string[]>) => ({ of: (t: T): TicketFiles => ({ all: by[t.id] ?? [], unmergeable: [] }) });

test("a ticket sent back after a conflict resolves only after the green branch that shares its file has landed", async () => {
  const order: string[] = [];
  const told: Change<G, string>[] = [];
  const rLands = [] as ("conflict" | "merged")[];
  const gReady = later();
  const schedule = createSchedule<T, G, string>({ tickets: [{ id: "10" }, { id: "20" }], files: filesOf({ 10: ["src/a.ts"], 20: ["src/a.ts", "src/b.ts"] }) });
  const { endings } = await schedule.run({
    workers: 2,
    attempt: async (t, at) => {
      if (t.id === "20") {
        // Green while 10's landing is still being made: it queues behind it.
        await tick();
        gReady.open();
        return green(t.id);
      }
      order.push(`attempt 10 #${at.n}`);
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10") {
        // The first landing of 10 returns only once 20 is green and queued to land.
        if (!rLands.length) await gReady.done;
        const got: Landed = rLands.length ? { kind: "merged" } : { kind: "conflict", files: ["src/a.ts"], with: [] };
        rLands.push(got.kind as "conflict" | "merged");
        order.push(`land 10 ${got.kind}`);
        return got;
      }
      await tick();
      await tick();
      order.push(`land ${g.issue} merged`);
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  assert.deepEqual(order, ["attempt 10 #1", "land 10 conflict", "land 20 merged", "attempt 10 #2", "land 10 merged"]);
  assert.equal(endings.get("10")?.kind, "landing");
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
  // Said, so the status view does not show a ticket queued and doing nothing.
  const waits = told.find((c) => c.kind === "resolve waits");
  assert.deepEqual(waits, { kind: "resolve waits", id: "10", for: ["20"] });
  assert.ok(told.findIndex((c) => c.kind === "resolve starts") > told.findIndex((c) => c.kind === "ended" && c.id === "20"));
});

test("a sent-back ticket does not wait for a green branch that shares none of its files", async () => {
  const order: string[] = [];
  const gReady = later();
  let first = true;
  const schedule = createSchedule<T, G, string>({ tickets: [{ id: "10" }, { id: "20" }], files: filesOf({ 10: ["src/a.ts"], 20: ["src/other.ts"] }) });
  await schedule.run({
    workers: 2,
    attempt: async (t, at) => {
      if (t.id === "20") {
        await tick();
        gReady.open();
        return green(t.id);
      }
      order.push(`attempt 10 #${at.n}`);
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10") {
        if (first) {
          await gReady.done;
          first = false;
          order.push("land 10 conflict");
          return { kind: "conflict", files: ["src/a.ts"], with: [] };
        }
        order.push("land 10 merged");
        return { kind: "merged" };
      }
      await tick();
      await tick();
      await tick();
      order.push("land 20 merged");
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  assert.ok(order.indexOf("attempt 10 #2") < order.indexOf("land 20 merged"), order.join(" | "));
});

test("a second conflict caused by a landing after the resolve began sends the ticket back once more", async () => {
  const told: Change<G, string>[] = [];
  const attempts: number[] = [];
  const gate = later();
  let lands = 0;
  const schedule = createSchedule<T, G, string>({ tickets: [{ id: "10" }, { id: "30" }], files: filesOf({ 10: ["src/a.ts"], 30: ["src/c.ts"] }) });
  const { endings } = await schedule.run({
    workers: 2,
    attempt: async (t, at) => {
      if (t.id === "30") {
        // Green and landed while 10's second attempt is under way.
        await gate.done;
        return green(t.id);
      }
      attempts.push(at.n);
      if (attempts.length === 2) {
        gate.open();
        // Long enough for 30 to land on the base the resolve already merged.
        for (let i = 0; i < 10; i++) await tick();
      }
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "30") return { kind: "merged" };
      lands++;
      // The resolve's own landing meets 30's: a conflict naming it. The first landing conflicted with nothing landed.
      if (lands === 1) return { kind: "conflict", files: ["src/a.ts"], with: [] };
      if (lands === 2) return { kind: "conflict", files: ["src/a.ts"], with: ["30"] };
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  assert.equal(told.filter((c) => c.kind === "requeued" && c.id === "10").length, 2);
  assert.deepEqual(attempts, [1, 2, 2]);
  const ending = endings.get("10");
  assert.equal(ending?.kind, "landing");
  assert.equal((ending as { landed: Landed }).landed.kind, "merged");
});

test("a second conflict with a ticket that landed before the resolve began ends the ticket conflicted", async () => {
  const told: Change<G, string>[] = [];
  const attempts: number[] = [];
  const landed30 = later();
  const schedule = createSchedule<T, G, string>({ tickets: [{ id: "10" }, { id: "30" }], files: filesOf({ 10: ["src/a.ts"], 30: ["src/c.ts"] }) });
  const { endings } = await schedule.run({
    workers: 2,
    attempt: async (t, at) => {
      if (t.id === "10") {
        attempts.push(at.n);
        // 30 lands first, so it is on the base before the resolve begins.
        if (at.n === 1) await landed30.done;
      }
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "30") {
        landed30.open();
        return { kind: "merged" };
      }
      // The resolve's merge held 30, so a conflict naming it is the resolve's own.
      return attempts.length === 1 ? { kind: "conflict", files: ["src/a.ts"], with: [] } : { kind: "conflict", files: ["src/a.ts"], with: ["30"] };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(told.filter((c) => c.kind === "requeued").length, 1);
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "conflict");
});

test("while a sent-back ticket waits to resolve, the run still says which landing it is at", async () => {
  const told: Change<G, string>[] = [];
  const greens = later();
  let ready = 0;
  let first = true;
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }, { id: "30" }],
    files: filesOf({ 10: ["src/a.ts"], 20: ["src/a.ts"], 30: ["src/a.ts"] }),
  });
  await schedule.run({
    workers: 3,
    attempt: async (t) => {
      if (t.id !== "10" && ++ready === 2) greens.open();
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && first) {
        // 20 and 30 are green and queued behind it: 10's resolve waits for both to land.
        await greens.done;
        first = false;
        return { kind: "conflict", files: ["src/a.ts"], with: [] };
      }
      await tick();
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  assert.ok(told.some((c) => c.kind === "resolve waits"));
  // The pipelines are idle but for the wait, which runs no agent: each landing is said, the third (30's) too, not left at the second.
  assert.deepEqual(
    told.flatMap((c) => (c.kind === "landing" ? [c.at] : [])),
    [1, 2, 3, 4],
  );
});
