// The file hold inside the scheduler (createSchedule in src/schedule.ts), driven through its
// interface with made-up files and fake work: `start` gives the candidates in start order with each
// one's wait, a ticket parked behind a file git cannot merge starts as its holder ends and is told
// so, it is told it waits for the next run when the run stops first, and a dry run (no files)
// holds nothing. No git, no Docker, no network.
//
//   node --test test/schedule-hold.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Attempted, type Change, createSchedule, type Plan, type TicketFiles, type Work } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
// Every ticket changes `lock` (git cannot merge it) and its own file.
const files = (unmergeable: Record<string, string[]>): Plan<T>["files"] => ({
  of: (t): TicketFiles => ({ all: [`${t.id}.ts`, ...(unmergeable[t.id] ?? [])], unmergeable: unmergeable[t.id] ?? [] }),
});

/** Runs `plan` with fake work; returns what was told and the order of attempts and landings, with the most attempts at once. */
const play = async (plan: Plan<T, string>, o: { attempt?: Work<T, G, string>["attempt"]; workers?: number } = {}) => {
  const told: Change<G, string, string>[] = [];
  const order: string[] = [];
  let running = 0;
  let peak = 0;
  const schedule = createSchedule<T, G, string, string>(plan);
  const { endings, stop } = await schedule.run({
    workers: o.workers ?? 4,
    attempt: async (t, at) => {
      order.push(`attempt ${t.id}`);
      peak = Math.max(peak, ++running);
      await tick();
      running--;
      return (o.attempt ?? (async () => green(t.id)))(t, at);
    },
    land: async (g) => (order.push(`land ${g.issue}`), { kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  return { start: schedule.start, endings, stop, told, order, peak };
};

test("start gives the candidates in start order, each with its wait: now, then dependants, then parked", () => {
  const { start } = createSchedule<T, G, unknown, string>({
    tickets: [{ id: "1" }, { id: "2" }, { id: "3" }],
    files: files({ 1: ["lock"], 2: ["lock"] }),
    // 9 waits for 2, which is parked: it still starts in this run, so 9 does too.
    blockers: { held: [{ ticket: { id: "9" }, on: ["2"] }], ticketOf: (b) => b },
  });
  assert.deepEqual(
    start.map((c) => [c.ticket.id, c.wait, c.file]),
    [
      ["1", undefined, undefined],
      ["3", undefined, undefined],
      ["9", "blockers", undefined],
      ["2", "file", { with: "1", file: "lock" }],
    ],
  );
});

test("two tickets sharing a file git cannot merge never run at once; the parked one starts when its holder ends, and is told so", async () => {
  const { endings, told, order, peak } = await play({ tickets: [{ id: "1" }, { id: "2" }], files: files({ 1: ["lock"], 2: ["lock"] }) });
  assert.equal(peak, 1);
  assert.deepEqual(order, ["attempt 1", "land 1", "attempt 2", "land 2"]);
  const at = (kind: string, id: string) => told.findIndex((c) => c.kind === kind && "id" in c && c.id === id);
  // Told after the holder's ending and before it is attempted.
  assert.ok(at("ended", "1") < at("started", "2"));
  assert.deepEqual(told[at("started", "2")], { kind: "started", id: "2", after: { kind: "file", freed: "1" }, shares: [] });
  assert.equal(endings.get("2")?.kind, "landing");
});

test("a holder that leaves the run without landing frees the file all the same", async () => {
  const { endings, order } = await play(
    { tickets: [{ id: "1" }, { id: "2" }], files: files({ 1: ["lock"], 2: ["lock"] }) },
    { attempt: async (t) => (t.id === "1" ? { kind: "pipeline", outcome: "gate red" } : green(t.id)) },
  );
  assert.deepEqual(order, ["attempt 1", "attempt 2", "land 2"]);
  assert.deepEqual([endings.get("1")?.kind, endings.get("2")?.kind], ["pipeline", "landing"]);
});

test("a run that stops first tells a parked ticket it waits for the next run, and it ends waiting for a file", async () => {
  // 3 finds a usage limit; 1 still lands, but nothing parked starts.
  const usage = { kind: "usage limit", line: "usage 97% of the 5-hour window" } as const;
  const { endings, told, order } = await play(
    { tickets: [{ id: "1" }, { id: "2" }, { id: "3" }], files: files({ 1: ["lock"], 2: ["lock"] }) },
    { attempt: async (t) => (t.id === "3" ? { kind: "not begun", why: usage } : new Promise((resolve) => setTimeout(() => resolve(green(t.id)), 10))) },
  );
  assert.ok(!order.includes("attempt 2"), order.join(" | "));
  assert.ok(order.includes("land 1"), order.join(" | "));
  assert.ok(!told.some((c) => c.kind === "started"));
  // Once 1 is gone, 2 waits behind nobody.
  assert.deepEqual(told.filter((c) => c.kind === "next run" && c.freed === "1"), [{ kind: "next run", id: "2", freed: "1" }]);
  assert.deepEqual(endings.get("2"), { kind: "waiting", on: "file" });
});

test("a dependant its blocker frees is parked behind a file in flight, told as parked, and starts once that one ends", async () => {
  const { told, order, peak } = await play(
    {
      tickets: [{ id: "1" }, { id: "2" }],
      files: files({ 2: ["lock"], 9: ["lock"] }),
      // 9 waits for 1; once 1 lands, its blockers read as all closed.
      blockers: { held: [{ ticket: { id: "9" }, on: ["1"] }], ticketOf: (b) => b, open: async (ts) => ts.map(() => []) },
    },
    // 2 holds the lock until after 1 has landed and freed 9.
    { attempt: async (t) => (t.id === "2" ? new Promise((resolve) => setTimeout(() => resolve(green("2")), 30)) : green(t.id)) },
  );
  assert.deepEqual(
    told.filter((c) => (c.kind === "waits" || c.kind === "started") && c.id === "9"),
    [
      { kind: "waits", id: "9", wait: { with: "2", file: "lock" }, parked: true },
      { kind: "started", id: "9", after: { kind: "file", freed: "2" }, shares: [] },
    ],
  );
  assert.ok(order.indexOf("land 2") < order.indexOf("attempt 9"), order.join(" | "));
  assert.equal(peak, 2);
});

test("a parked ticket whose label refuses it is not begun when freed, and gives the file to the next", async () => {
  const { endings, order, told } = await play({
    tickets: [{ id: "1" }, { id: "2" }, { id: "3" }],
    files: files({ 1: ["lock"], 2: ["lock"], 3: ["lock"] }),
    checkLabel: (t) => (t.id === "2" ? "NOT STARTED: #2 has the label effort:turbo" : undefined),
  });
  assert.deepEqual(order, ["attempt 1", "land 1", "attempt 3", "land 3"]);
  // Told once, as its ending: the burndown says and records the refusal from it.
  assert.equal(told.filter((c) => c.kind === "ended" && c.id === "2").length, 1);
  assert.deepEqual(endings.get("2"), { kind: "not begun", why: { kind: "refused label", reason: "NOT STARTED: #2 has the label effort:turbo" } });
});

test("last() is false while a ticket is parked behind a file", async () => {
  const lasts: Record<string, boolean> = {};
  await play(
    { tickets: [{ id: "1" }, { id: "2" }], files: files({ 1: ["lock"], 2: ["lock"] }) },
    { attempt: async (t, at) => ((lasts[t.id] = at.last()), green(t.id)) },
  );
  assert.deepEqual(lasts, { 1: false, 2: true });
});

test("a dry run holds nothing: without files every ticket starts at once", async () => {
  const plan = { tickets: [{ id: "1" }, { id: "2" }] };
  const { start, told, peak } = await play(plan);
  assert.deepEqual(start.map((c) => c.wait), [undefined, undefined]);
  assert.equal(peak, 2);
  assert.ok(!told.some((c) => c.kind === "waits" || c.kind === "started" || c.kind === "next run"));
});
