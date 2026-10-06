// The release of dependants inside the scheduler (createSchedule in src/schedule.ts), driven
// through its interface with a fake blockers port and fake work: a ticket held for a blocker in
// this run starts once its blockers have landed, before the run ends; one whose blocker ends without
// landing, or whose run starts nothing, waits for the next run; and on every ending the ticket's
// files are freed and its dependants released before the open count drops. No git, no Docker, no
// network.
//
//   node --test test/schedule-release.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Attempted, type Change, createSchedule, type Plan, type TicketFiles, type Work } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };
// A blocker is the id it names; one that is not a number is outside the run.
type B = string;

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const usage = { kind: "usage limit", line: "usage 97% of the 5-hour window" } as const;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const files = (unmergeable: Record<string, string[]>): Plan<T, B>["files"] => ({
  of: (t): TicketFiles => ({ all: [`${t.id}.ts`, ...(unmergeable[t.id] ?? [])], unmergeable: unmergeable[t.id] ?? [] }),
});

/**
 * `held`: id -> what it waits for. `open` answers the blockers port: by default a blocker that has
 * landed reads as closed, any other as open (`asked` records each call).
 */
const play = async (
  ids: string[],
  held: Record<string, B[]>,
  o: {
    files?: Plan<T, B>["files"];
    open?: NonNullable<Plan<T, B>["blockers"]>["open"] | null;
    attempt?: Work<T, G, string, B>["attempt"];
    land?: Work<T, G, string, B>["land"];
    workers?: number;
  } = {},
) => {
  const told: Change<G, string, B>[] = [];
  const order: string[] = [];
  const asked: string[] = [];
  const open: NonNullable<Plan<T, B>["blockers"]>["open"] = async (ts, landed) => {
    asked.push(`${ts.map((t) => t.id).join(",")} after ${[...landed].join(",")}`);
    return ts.map((t) => held[t.id].filter((b) => !landed.has(b)));
  };
  const schedule = createSchedule<T, G, string, B>({
    tickets: ids.map((id) => ({ id })),
    files: o.files,
    blockers: {
      held: Object.entries(held).map(([id, on]) => ({ ticket: { id }, on })),
      ticketOf: (b) => (/^\d+$/.test(b) ? b : undefined),
      ...(o.open === null ? {} : { open: o.open ?? open }),
    },
  });
  const { endings, stop } = await schedule.run({
    workers: o.workers ?? 4,
    attempt: async (t, at) => {
      order.push(`attempt ${t.id}`);
      await tick();
      return (o.attempt ?? (async () => green(t.id)))(t, at);
    },
    land: async (g) => {
      order.push(`land ${g.issue}`);
      return (o.land ?? (async () => ({ kind: "merged" }) as const))(g);
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  // What was told, as short lines, in order.
  const lines = told.flatMap((c) => {
    switch (c.kind) {
      case "ended":
        return [`ended ${c.id}`];
      case "started":
        return [`started ${c.id} after ${c.after.kind === "file" ? `file ${c.after.freed}` : "blockers"}`];
      case "waits":
        return [`waits ${c.id} for ${c.wait.with}`];
      case "blocked":
        return [`blocked ${c.id} on ${c.on.join(",")} in flight ${c.inFlight.join(",")}`];
      case "unreleased":
        return [`unreleased ${c.id}`];
      default:
        return [];
    }
  });
  return { start: schedule.start, endings, stop, told, lines, order, asked };
};

test("on an ending the file is freed, then the dependants are released, then the open count drops", async () => {
  // 1 and 3 share a lock, so 3 is parked behind 1; 2 waits for 1 and has the lock too.
  const { lines, order, endings } = await play(["1", "3"], { 2: ["1"] }, { files: files({ 1: ["lock"], 2: ["lock"], 3: ["lock"] }) });
  const after1 = lines.slice(lines.indexOf("ended 1"));
  // The file first: 3, which waited longest, starts; then 2 is freed and parked behind 3, which has the lock now.
  assert.deepEqual(after1.slice(0, 3), ["ended 1", "started 3 after file 1", "waits 2 for 3"], lines.join(" | "));
  assert.ok(lines.indexOf("started 2 after file 3") > lines.indexOf("ended 3"), lines.join(" | "));
  // And the run did not close its queues at 1's ending: both started after it, and both landed.
  assert.deepEqual(order, ["attempt 1", "land 1", "attempt 3", "land 3", "attempt 2", "land 2"]);
  assert.deepEqual([endings.get("2")?.kind, endings.get("3")?.kind], ["landing", "landing"]);
});

test("a dependant that shares its blocker's file starts as the blocker lands, not parked behind it", async () => {
  // Were its blockers read before the file was freed, 2 would wait for 1, which has just ended.
  const { lines, order, endings } = await play(["1"], { 2: ["1"] }, { files: files({ 1: ["lock"], 2: ["lock"] }) });
  assert.ok(lines.includes("started 2 after blockers"), lines.join(" | "));
  assert.ok(!lines.some((l) => l.startsWith("waits 2")), lines.join(" | "));
  assert.deepEqual(order, ["attempt 1", "land 1", "attempt 2", "land 2"]);
  assert.equal(endings.get("2")?.kind, "landing");
});

test("a chain whose blockers land in this run starts link by link before the run ends", async () => {
  const { order, endings, asked, start } = await play(["1"], { 2: ["1"], 3: ["2"], 4: ["3"] });
  assert.deepEqual(
    start.map((c) => [c.ticket.id, c.wait]),
    [
      ["1", undefined],
      ["2", "blockers"],
      ["3", "blockers"],
      ["4", "blockers"],
    ],
  );
  assert.deepEqual(order, ["attempt 1", "land 1", "attempt 2", "land 2", "attempt 3", "land 3", "attempt 4", "land 4"]);
  // Each landing asks only of the tickets that waited for it, with what has landed so far.
  assert.deepEqual(asked, ["2 after 1", "3 after 1,2", "4 after 1,2,3"]);
  assert.deepEqual([...endings.values()].map((e) => e.kind), ["landing", "landing", "landing", "landing"]);
});

test("a diamond's dependant starts only after its second blocker lands", async () => {
  // One worker: 2's attempt runs while 1 lands, so 3 waits for 2's landing.
  const { order, lines } = await play(["1", "2"], { 3: ["1", "2"] }, { workers: 1 });
  assert.deepEqual(order, ["attempt 1", "attempt 2", "land 1", "land 2", "attempt 3", "land 3"]);
  // After 1, 3 still waits for 2, which lands this run.
  assert.ok(lines.includes("blocked 3 on 2 in flight 2,3"), lines.join(" | "));
});

test("a held ticket that also waits on something outside the run is the next run's, transitively", async () => {
  const { start, endings, order } = await play(["1"], { 2: ["1"], 3: ["2"], 4: ["1", "ENG-1"], 5: ["4"] });
  assert.deepEqual(start.map((c) => c.ticket.id), ["1", "2", "3"]);
  assert.deepEqual(order, ["attempt 1", "land 1", "attempt 2", "land 2", "attempt 3", "land 3"]);
  assert.equal(endings.has("4"), false);
  // Nothing starts now: no dependant is a candidate.
  const none = await play([], { 2: ["1"] });
  assert.deepEqual(none.start, []);
});

test("a blocker that ends without landing releases nothing; its dependant is told it is not in this run, and waits", async () => {
  const { lines, endings, asked, order } = await play(["1"], { 2: ["1"] }, { attempt: async () => ({ kind: "pipeline", outcome: "gate red" }) });
  assert.deepEqual(asked, []);
  assert.deepEqual(order, ["attempt 1"]);
  // 1 is no longer in flight: the burndown words it as waiting for the next run.
  assert.deepEqual(lines, ["ended 1", "blocked 2 on 1 in flight 2"]);
  assert.deepEqual(endings.get("2"), { kind: "waiting", on: "blockers" });

  // A landing that does not close its ticket (held for a person) is the same.
  const heldBack = await play(["1"], { 2: ["1"] }, { land: async () => ({ kind: "held", paths: [".github/workflows/ci.yml"], reason: "human merge", by: "protected" }) });
  assert.deepEqual(heldBack.asked, []);
  assert.deepEqual(heldBack.endings.get("2"), { kind: "waiting", on: "blockers" });
});

test("a run that starts nothing releases nothing, and the dependant waits for the next run", async () => {
  // 9 finds a usage limit before it begins; 1 still lands, but 2 does not start.
  const { order, endings, asked, stop } = await play(["1", "9"], { 2: ["1"] }, {
    attempt: async (t) => (t.id === "9" ? { kind: "not begun", why: usage } : (await new Promise((resolve) => setTimeout(resolve, 10)), green(t.id))),
  });
  assert.equal(stop.startsNothing, true);
  assert.deepEqual(asked, []);
  assert.ok(order.includes("land 1") && !order.includes("attempt 2"), order.join(" | "));
  assert.deepEqual(endings.get("2"), { kind: "waiting", on: "blockers" });
});

test("a stop that arrives while the blockers are read starts nothing", async () => {
  // 9's attempt finds the usage limit while 1's dependants are being read.
  let reading!: () => void;
  const isReading = new Promise<void>((resolve) => (reading = resolve));
  let stopped!: () => void;
  const isStopped = new Promise<void>((resolve) => (stopped = resolve));
  const { order, endings } = await play(["1", "9"], { 2: ["1"] }, {
    open: async (ts) => {
      reading();
      await isStopped;
      return ts.map(() => []);
    },
    attempt: async (t) => {
      if (t.id !== "9") return green(t.id);
      await isReading;
      queueMicrotask(stopped);
      return { kind: "not begun", why: usage };
    },
  });
  assert.ok(!order.includes("attempt 2"), order.join(" | "));
  assert.deepEqual(endings.get("2"), { kind: "waiting", on: "blockers" });
});

test("blockers that cannot be read again are told as unreleased, and the run still ends", async () => {
  const { lines, endings } = await play(["1"], { 2: ["1"] }, { open: async () => Promise.reject(new Error("gh: HTTP 502")) });
  assert.deepEqual(lines, ["ended 1", "unreleased 1", "blocked 2 on 1 in flight 2"]);
  assert.deepEqual(endings.get("2"), { kind: "waiting", on: "blockers" });
});

test("a dry run (no open port) releases nothing", async () => {
  const { order, endings } = await play(["1"], { 2: ["1"] }, { open: null });
  assert.deepEqual(order, ["attempt 1", "land 1"]);
  assert.deepEqual(endings.get("2"), { kind: "waiting", on: "blockers" });
});

test("last() is false while a held ticket waits for one in flight", async () => {
  const lasts: Record<string, boolean> = {};
  await play(["1"], { 2: ["1"] }, { attempt: async (t, at) => ((lasts[t.id] = at.last()), green(t.id)) });
  assert.deepEqual(lasts, { 1: false, 2: true });
});
