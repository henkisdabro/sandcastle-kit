// A sent-back ticket's wait for the tickets ahead of its resolve is handed to its second attempt as
// `resolveWaitMs`, which `burndown()` adds to the `waitMs` of that attempt's `setup` line (the path a
// slot wait takes). The clock is the test's own (`now` of the plan's work); the scheduler's one-second
// wake-up is real time. No git, no Docker, no network.
//
//   pnpm test:file test/resolve-wait-recorded.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { withQueued } from "../src/gates.ts";
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
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ok(), what);
};

test("a requeued ticket's attempt is told how long its resolve waited, and a first attempt is told none", async () => {
  let clock = 1_000;
  const told: Change<G, string>[] = [];
  const requeued = later();
  const run20 = later();
  const land20 = later();
  const attempts: { id: string; n: number; resolveWaitMs?: number }[] = [];
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }],
    files: { of: (): TicketFiles => ({ all: ["src/a.ts"], unmergeable: [] }) },
  });
  const running = schedule.run({
    workers: 2,
    now: () => clock,
    attempt: async (t, at) => {
      attempts.push({ id: t.id, n: at.n, resolveWaitMs: at.resolveWaitMs });
      if (t.id === "20") await run20.done;
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
  // The wait is on while 20 is in its pipeline: the minutes that pass on the run's clock are the wait.
  await until("the resolve waits", () => told.some((c) => c.kind === "requeued"));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  clock += 90_000;
  run20.open();
  await until("20 queued to land", () => attempts.filter((a) => a.id === "20").length === 1);
  clock += 30_000;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  land20.open();
  await running;
  assert.deepEqual(attempts.filter((a) => a.n === 1).map((a) => a.resolveWaitMs), [undefined, undefined]);
  const second = attempts.filter((a) => a.id === "10" && a.n === 2);
  assert.equal(second.length, 1);
  assert.equal(second[0].resolveWaitMs, 120_000);
});

test("a requeued ticket whose resolve waited for nothing is told no wait", async () => {
  const told: Change<G, string>[] = [];
  const attempts: { id: string; n: number; resolveWaitMs?: number }[] = [];
  const schedule = createSchedule<T, G, string>({ tickets: [{ id: "10" }], files: { of: (): TicketFiles => ({ all: ["src/a.ts"], unmergeable: [] }) } });
  await schedule.run({
    workers: 1,
    attempt: async (t, at) => {
      attempts.push({ id: t.id, n: at.n, resolveWaitMs: at.resolveWaitMs });
      return green(t.id);
    },
    land: async (g) => (g.issue === "10" && !told.some((c) => c.kind === "requeued") ? ({ kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed) : ({ kind: "merged" } satisfies Landed)),
    host: { check: async () => {}, failed: undefined },
    tell: (c) => told.push(c),
  });
  assert.deepEqual(attempts.map((a) => [a.n, a.resolveWaitMs]), [[1, undefined], [2, undefined]]);
});

test("the resolve wait goes onto the setup line's waitMs, out of its ms", () => {
  assert.deepEqual(withQueued({ ms: 4_000 }, 7 * 60_000), { ms: 4_000, waitMs: 7 * 60_000 });
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /\n      at\?\.resolveWaitMs,\n/);
  assert.match(source, /pipeline\(issue, \{[^}]*resolveWaitMs \}\)/);
});
