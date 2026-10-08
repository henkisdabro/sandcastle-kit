// The run's demand for sandbox slots, as the scheduler (createSchedule in src/schedule.ts) tells
// it for the machine pool's shares: the tickets in a pipeline or ready for one, plus one while a
// green branch waits to land or is landing, never more than the run's concurrency, and nothing for
// a ticket held for a blocker until that blocker lands. Told whenever the count changes, 0 once
// the run is drained. Fake work, no git, no Docker, no network.
//
//   pnpm test:file test/schedule-demand.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Attempted, type Change, createSchedule, type Plan, type Work } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };
type B = string;

const green = (id: string): Attempted<G, string> => ({ kind: "green", green: { issue: id } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await tick();
  assert.ok(ok(), "timed out");
};

/** A gate an attempt or a landing waits at until the test lets it through. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

const demands = (told: Change<G, string, B>[]) => told.flatMap((c) => (c.kind === "demand" ? [c.n] : []));

/** `ids` are the tickets ready to start; `held` are the others, each waiting for the blockers it names. */
const start = (ids: string[], o: { concurrency?: number; workers?: number; held?: Record<string, B[]>; attempt?: Work<T, G, string, B>["attempt"]; land?: Work<T, G, string, B>["land"] } = {}) => {
  const told: Change<G, string, B>[] = [];
  const held = o.held ?? {};
  const plan: Plan<T, B> = {
    tickets: ids.map((id) => ({ id })),
    blockers: {
      held: Object.entries(held).map(([id, on]) => ({ ticket: { id }, on })),
      ticketOf: (b) => b,
      open: async (ts, landed) => ts.map((t) => held[t.id].filter((b) => !landed.has(b))),
    },
  };
  const schedule = createSchedule<T, G, string, B>(plan);
  const done = schedule.run({
    workers: o.workers ?? 4,
    ...(o.concurrency === undefined ? {} : { concurrency: o.concurrency }),
    attempt: o.attempt ?? (async (t) => green(t.id)),
    land: o.land ?? (async () => ({ kind: "merged" }) as const),
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  return { told, done };
};

test("demand counts the tickets ready to start, and is 0 once the run is drained", async () => {
  const hold = gate();
  const { told, done } = start(["1", "2", "3"], { concurrency: 5, attempt: async (t) => (await hold.opened, green(t.id)) });
  await until(() => demands(told).length > 0);
  assert.equal(demands(told)[0], 3);
  hold.open();
  await done;
  assert.equal(demands(told).at(-1), 0);
  // Told when it changes, never twice in a row.
  assert.ok(demands(told).every((n, i, all) => i === 0 || n !== all[i - 1]));
});

test("demand adds one for a green branch waiting to land, and drops it once landed", async () => {
  const attempts = { "1": gate(), "2": gate() };
  const landing = gate();
  const { told, done } = start(["1", "2"], {
    concurrency: 5,
    attempt: async (t) => (await attempts[t.id as "1" | "2"].opened, green(t.id)),
    land: async () => (await landing.opened, { kind: "merged" } as const),
  });
  await until(() => demands(told).length === 1);
  // One pipeline ends green: one left running and one landing, still 2 - nothing to tell.
  attempts["1"].open();
  await tick();
  await tick();
  assert.deepEqual(demands(told), [2]);
  // Both green: no pipeline, and the landing worker wants one slot.
  attempts["2"].open();
  await until(() => demands(told).length === 2);
  landing.open();
  await done;
  assert.deepEqual(demands(told), [2, 1, 0]);
});

test("a ticket held for a blocker adds nothing until the blocker lands", async () => {
  const landing = gate();
  const { told, done } = start(["1"], {
    concurrency: 5,
    held: { "2": ["1"] },
    land: async () => (await landing.opened, { kind: "merged" } as const),
  });
  // Ticket 1 runs (1), then waits to land (1): the held ticket 2 has added nothing.
  await until(() => demands(told).at(-1) === 1 && told.some((c) => c.kind === "landing" || c.kind === "demand"));
  await tick();
  assert.ok(Math.max(...demands(told)) <= 1, `demands ${demands(told)}`);
  landing.open();
  await done;
  // Ticket 1's landing released ticket 2, which then asked for its own slot.
  const after = told.findIndex((c) => c.kind === "started" && c.id === "2");
  assert.ok(after >= 0, "ticket 2 started in this run");
  assert.ok(demands(told.slice(after)).some((n) => n >= 1));
  assert.equal(demands(told).at(-1), 0);
});

test("demand never exceeds the run's concurrency", async () => {
  const hold = gate();
  const { told, done } = start(["1", "2", "3", "4", "5", "6"], { concurrency: 2, workers: 2, attempt: async (t) => (await hold.opened, green(t.id)) });
  await until(() => demands(told).length > 0);
  hold.open();
  await done;
  assert.equal(demands(told)[0], 2);
  assert.ok(Math.max(...demands(told)) <= 2, `demands ${demands(told)}`);
});

test("without a concurrency the demand is capped at the workers", async () => {
  const hold = gate();
  const { told, done } = start(["1", "2", "3"], { workers: 2, attempt: async (t) => (await hold.opened, green(t.id)) });
  await until(() => demands(told).length > 0);
  hold.open();
  await done;
  assert.ok(Math.max(...demands(told)) <= 2, `demands ${demands(told)}`);
});
