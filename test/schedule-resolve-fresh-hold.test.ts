// While a sent-back ticket waits to resolve its conflict, a ticket that has not started and shares a file
// with it does not start ahead of it: else each one that kept starting reached its gates ahead of the
// resolve and held it again. A ticket that shares no file starts at once on a free worker; the held one
// shows as blocked, with what it waits for, and starts after the resolve; a run that stops starting
// tickets ends it as not begun (createSchedule in src/schedule.ts, the hold record in src/burndown.ts).
// Driven through the scheduler's ports with made-up files and fake work. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-resolve-fresh-hold.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TicketRecord } from "../mod/hooks/run-record.ts";
import type { Landed } from "../src/landing.ts";
import { type Attempted, type Change, createSchedule, type TicketFiles } from "../src/schedule.ts";

// src/burndown.ts reads the config and cache directories when it loads.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createHoldRecord } = await import("../src/burndown.ts");

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
const FILES: Record<string, string> = { 10: "src/a.ts", 20: "src/a.ts", 15: "src/other.ts", 30: "src/a.ts", 40: "src/d.ts" };
const files = { of: (t: T): TicketFiles => ({ all: [FILES[t.id]!], unmergeable: [] }) };

// Two workers. 10 and 20 start; 10 goes green and conflicts at its landing while 20 is in its gates. 15 holds 10's
// worker until 10 is sent back, so that worker takes 10 again, which goes off to wait for 20: the worker is free, and
// 30 (shares a.ts with 10) and 40 (alone) have not started.
const play = (tickets: string[], twenty: (done: Promise<void>) => Promise<Attempted<G, string>>) => {
  const order: string[] = [];
  const told: Change<G, string>[] = [];
  const records: { id: string; fields: TicketRecord }[] = [];
  const holds = createHoldRecord({ waiting: [], ref: (id) => `#${id}`, say: () => {} });
  const record = { ticket: (id: string, fields: TicketRecord) => void records.push({ id, fields }), update: () => {} };
  const inGates = later();
  const run20 = later();
  const sentBack = later();
  let conflicted = false;
  const running = createSchedule<T, G, string>({ tickets: tickets.map((id) => ({ id })), files }).run({
    workers: 2,
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (t.id === "20") {
        at.gates();
        inGates.open();
        return twenty(run20.done);
      }
      if (t.id === "15") {
        await sentBack.done;
        await sleep(100);
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
    tell: (c) => {
      told.push(c);
      if (c.kind === "requeued") sentBack.open();
      if (c.kind === "resolve holds" || c.kind === "resolve frees") holds.tell(record, c);
    },
  });
  return { order, told, records, running, run20 };
};

test("a ticket that has not started and shares a file with a waiting resolve starts after it; one that shares none starts at once", async () => {
  const p = play(["10", "20", "15", "30", "40"], async (done) => {
    await done;
    return green("20");
  });
  await until("40 starts on the worker 10's wait left", () => p.order.includes("start 40 #1"));
  await until("40 lands", () => p.order.includes("land 40"));
  // 20 is still in its gates: 10 waits for it, and 30, which shares its file, waits for 10.
  await sleep(300);
  assert.equal(p.order.includes("start 30 #1"), false, p.order.join(" | "));
  assert.equal(p.order.includes("start 10 #2"), false, p.order.join(" | "));
  assert.deepEqual(
    p.told.filter((c) => c.kind === "resolve holds"),
    [{ kind: "resolve holds", id: "30", by: "10", file: "src/a.ts" }],
  );
  assert.deepEqual(p.records.at(-1), { id: "30", fields: { state: "blocked", note: "waits for #10 to resolve its conflict first (shares src/a.ts)" } });
  p.run20.open();
  const { endings } = await p.running;
  assert.ok(p.order.indexOf("land 20") < p.order.indexOf("start 10 #2"), p.order.join(" | "));
  assert.ok(p.order.indexOf("start 10 #2") < p.order.indexOf("start 30 #1"), p.order.join(" | "));
  // The note goes as it is released, before it starts.
  assert.deepEqual(p.records.at(-1), { id: "30", fields: { state: "queued", note: null } });
  for (const id of ["10", "15", "20", "30", "40"]) assert.equal(endings.get(id)?.kind, "landing", id);
});

test("a ticket held for a waiting resolve ends as not begun when the run stops starting tickets", async () => {
  const p = play(["10", "20", "15", "30"], async (done) => {
    await done;
    // The run starts nothing more: the resolve's wait ends, and so does the hold.
    return { kind: "pipeline", outcome: "red", causes: [{ kind: "usage limit", line: "usage at 98%" }] };
  });
  await until("30 is held for 10", () => p.told.some((c) => c.kind === "resolve holds" && c.id === "30"));
  p.run20.open();
  const { endings, stop } = await p.running;
  assert.equal(stop.startsNothing, true);
  assert.equal(endings.get("30")?.kind, "not begun");
  assert.equal(p.order.includes("start 30 #1"), false, p.order.join(" | "));
  assert.equal(p.order.includes("start 10 #2"), false, p.order.join(" | "));
  assert.equal(endings.get("10")?.kind, "landing");
});
