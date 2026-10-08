// A sent-back ticket's resolve wait is said once, after its list has held for RESOLVE_SETTLE_MS, with
// the tickets still in their pipelines worded apart from the branches queued to land; a wait that ends
// sooner is not said at all. The clock is the test's own (`now` of the plan's work); the scheduler's
// one-second wake-up is real time. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-resolve-settle.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveWaitNote } from "../src/burndown.ts";
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
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ok(), what);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a resolve wait is said once its list has held, worded by who is still running, and its change only updates the record", async () => {
  let clock = 0;
  const told: Change<G, string>[] = [];
  const requeued = later();
  const run20 = later();
  const run30 = later();
  const land20 = later();
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }, { id: "30" }],
    files: { of: (t: T): TicketFiles => ({ all: ["src/a.ts"], unmergeable: [] }) },
  });
  const waitsOf = () => told.flatMap((c) => (c.kind === "resolve waits" ? [c] : []));
  const running = schedule.run({
    workers: 3,
    now: () => clock,
    attempt: async (t) => {
      if (t.id === "20") await run20.done;
      if (t.id === "30") await run30.done;
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && !told.some((c) => c.kind === "requeued")) return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      if (g.issue === "20") await land20.done;
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      told.push(c);
      if (c.kind === "requeued") requeued.open();
    },
  });
  await requeued.done;
  // Held for less than the settling: nothing said.
  await sleep(1200);
  assert.deepEqual(waitsOf(), []);
  clock += RESOLVE_SETTLE_MS;
  await until("the wait is said", () => waitsOf().length === 1);
  assert.deepEqual(waitsOf()[0], { kind: "resolve waits", id: "10", for: ["20", "30"], running: ["20", "30"], first: true });
  // 20 goes green and queues to land: the list changes, and is said again only when it has held.
  run20.open();
  clock += 1000;
  await sleep(1200);
  assert.equal(waitsOf().length, 1);
  clock += RESOLVE_SETTLE_MS;
  await until("the change is said", () => waitsOf().length === 2);
  assert.deepEqual(waitsOf()[1], { kind: "resolve waits", id: "10", for: ["20", "30"], running: ["30"], first: false });
  assert.equal(told.filter((c) => c.kind === "resolve starts").length, 0);
  land20.open();
  run30.open();
  const { endings } = await running;
  assert.equal(told.filter((c) => c.kind === "resolve starts").length, 1);
  // Its end is said once nothing is ahead of it: after 20 and 30 have ended.
  const at = (ok: (c: Change<G, string>) => boolean) => told.findIndex(ok);
  for (const id of ["20", "30"]) assert.ok(at((c) => c.kind === "resolve starts") > at((c) => c.kind === "ended" && c.id === id), id);
  assert.equal(waitsOf().length, 2);
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
});

test("a resolve wait names a branch queued to land apart from a ticket still running", () => {
  const ref = (id: string) => `#${id}`;
  assert.equal(resolveWaitNote(ref, { for: ["442"], running: [] }), "waits to resolve its conflict until #442 has landed");
  assert.equal(resolveWaitNote(ref, { for: ["442", "443"], running: [] }), "waits to resolve its conflict until #442, #443 have landed");
  assert.equal(resolveWaitNote(ref, { for: ["441"], running: ["441"] }), "waits to resolve its conflict until #441 lands or leaves the run");
  assert.equal(resolveWaitNote(ref, { for: ["441", "445"], running: ["441", "445"] }), "waits to resolve its conflict until #441, #445 land or leave the run");
  assert.equal(resolveWaitNote(ref, { for: ["442", "441"], running: ["441"] }), "waits to resolve its conflict until #442 has landed and #441 lands or leaves the run");
});

test("the run's log says a resolve wait only for its first telling", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /if \(c\.first\) o\.say\(`[^`]*\$\{note\}/);
});
