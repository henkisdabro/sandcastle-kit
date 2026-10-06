// The order tickets start in once a run is going (createSchedule in src/schedule.ts): a ticket released
// when its last blocker lands, and a ticket requeued after a conflict at landing, start at the next free
// slot, ahead of every ticket that has not started; a requeued ticket goes before a released one, and
// equals in the order they arrived. Also the two lines the run prints about them (`createHoldRecord` in
// src/burndown.ts, `fileShareLine`). One pipeline slot, fake attempts and landings; no git, no Docker,
// no network.
//
//   node --test test/schedule-start-order.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing burndown.ts must not touch the real config or cache.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createHoldRecord } = await import("../src/burndown.ts");
const { createSchedule, fileShareLine } = await import("../src/schedule.ts");
type Change = import("../src/schedule.ts").Change<G, string, string>;
type Landed = import("../src/landing.ts").Landed;

type T = { id: string };
type G = { issue: string };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ref = (id: string) => `#${id}`;
const CONFLICT: Landed = { kind: "conflict", files: ["shared.txt"], with: ["9"] };

/**
 * One pipeline slot. `ids` start in order and `dependants` (id -> its one blocker) are released as
 * the blocker lands. The first attempt of `slow` holds the slot until `ready` says everything it waits
 * to see has been told, so the landings and the release or requeue happen while the three tickets
 * that have not started are still queued. `conflicts` conflict on their first landing.
 */
const play = async (o: { ids: string[]; dependants?: Record<string, string>; slow: string; conflicts?: string[]; ready: (told: Change[]) => boolean }) => {
  const dependants = o.dependants ?? {};
  const told: Change[] = [];
  const attempts: string[] = [];
  const landedOnce = new Set<string>();
  const schedule = createSchedule<T, G, string, string>({
    tickets: o.ids.map((id) => ({ id })),
    blockers: {
      held: Object.entries(dependants).map(([id, on]) => ({ ticket: { id }, on: [on] })),
      ticketOf: (b) => b,
      open: async (ts) => ts.map(() => []),
    },
  });
  await schedule.run({
    workers: 1,
    attempt: async (t, at) => {
      attempts.push(at.n === 2 ? `${t.id}#2` : t.id);
      if (t.id === o.slow && at.n === 1) {
        while (!o.ready(told)) await tick();
        // The release and the requeue push their ticket right after telling it.
        await tick();
      }
      return { kind: "green", green: { issue: t.id } };
    },
    land: async (g) => {
      // Every landing happens while the slow attempt holds the slot, whatever order the attempts ended in.
      while (!attempts.includes(o.slow)) await tick();
      if (o.conflicts?.includes(g.issue) && !landedOnce.has(g.issue)) {
        landedOnce.add(g.issue);
        return CONFLICT;
      }
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  return attempts;
};

const released = (id: string) => (told: Change[]) => told.some((c) => c.kind === "started" && c.id === id);
const requeued = (id: string) => (told: Change[]) => told.some((c) => c.kind === "requeued" && c.id === id);

test("a ticket released while three others have not started starts at the next free slot, before them", async () => {
  const attempts = await play({ ids: ["1", "2", "3", "4", "5"], dependants: { 6: "1" }, slow: "2", ready: released("6") });
  assert.deepEqual(attempts, ["1", "2", "6", "3", "4", "5"]);
});

test("a ticket requeued after a conflict while three others have not started starts at the next free slot, before them", async () => {
  const attempts = await play({ ids: ["1", "2", "3", "4", "5"], slow: "2", conflicts: ["1"], ready: requeued("1") });
  assert.deepEqual(attempts, ["1", "2", "1#2", "3", "4", "5"]);
});

test("a requeued ticket starts before a released one that arrived at the same time, and before the ones that have not started", async () => {
  // 1 lands and releases 7; 6 then conflicts and is requeued: both wait behind 2, whose attempt is slow.
  const attempts = await play({
    ids: ["1", "6", "2", "3", "4", "5"],
    dependants: { 7: "1" },
    slow: "2",
    conflicts: ["6"],
    ready: (told) => released("7")(told) && requeued("6")(told),
  });
  assert.deepEqual(attempts, ["1", "6", "2", "6#2", "7", "3", "4", "5"]);
});

test("released tickets start in the order they were released", async () => {
  const attempts = await play({ ids: ["1", "2", "3", "4", "5", "6"], dependants: { 7: "1", 8: "2" }, slow: "3", ready: (told) => released("7")(told) && released("8")(told) });
  assert.deepEqual(attempts, ["1", "2", "3", "7", "8", "4", "5", "6"]);
});

test("requeued tickets start in the order they were sent back", async () => {
  const attempts = await play({ ids: ["1", "2", "3", "4", "5", "6"], slow: "3", conflicts: ["1", "2"], ready: (told) => requeued("1")(told) && requeued("2")(told) });
  assert.deepEqual(attempts, ["1", "2", "3", "1#2", "2#2", "4", "5", "6"]);
});

test("the release line says the ticket was released and starts at the next free slot, not that it starts", () => {
  const said: string[] = [];
  const holds = createHoldRecord({ waiting: [], ref, say: (line) => void said.push(line.trim()) });
  const record = { ticket: () => {}, update: () => {} };
  holds.tell(record, { kind: "started", id: "7", after: { kind: "blockers" }, shares: [] });
  assert.deepEqual(said, ["#7 released: its last blocker has landed; it starts at the next free slot"]);
});

test("the run record puts a requeued ticket, then released ones, ahead of every ticket not yet started, so the view's queue position is true", () => {
  const orders: Record<string, number | undefined> = {};
  const holds = createHoldRecord({ waiting: [], ref, say: () => {} });
  const record = { ticket: (id: string, f: { order?: number }) => void (f.order !== undefined && (orders[id] = f.order)), update: () => {} };
  holds.tell(record, { kind: "started", id: "7", after: { kind: "blockers" }, shares: [] });
  holds.tell(record, { kind: "requeued", id: "5" });
  holds.tell(record, { kind: "started", id: "8", after: { kind: "blockers" }, shares: [] });
  holds.tell(record, { kind: "requeued", id: "6" });
  // A ticket freed from a file starts in arrival order with the rest, and keeps the place `start` gave it.
  holds.tell(record, { kind: "started", id: "9", after: { kind: "file", freed: "1" }, shares: [] });
  // Tickets not yet started are ordered from 0, by their place in `start`.
  assert.ok(Object.values(orders).every((n) => n !== undefined && n < 0), JSON.stringify(orders));
  assert.ok(orders["5"]! < orders["6"]! && orders["6"]! < orders["7"]! && orders["7"]! < orders["8"]!, JSON.stringify(orders));
  assert.equal(orders["9"], undefined);
});

test("the start line for two tickets that change one file says what happens at landing", () => {
  const { start } = createSchedule<T, G>({
    tickets: [{ id: "1" }, { id: "2" }],
    files: { of: () => ({ all: ["page.html"], unmergeable: [] }) },
  });
  assert.deepEqual(
    start[1].shares?.map((s) => fileShareLine(ref, "2", s)),
    ["#1 and #2 both change page.html - if they conflict at landing, the later one is sent back once and its merge resolved"],
  );
});
