// A sent-back ticket's recorded resolve wait leaves out the time a pause held the run after its requeue,
// and only that: a landing goes on during a pause, so a conflict can send a ticket back in the middle of
// one, and the part of that pause before the requeue is no part of its wait (createSchedule in
// src/schedule.ts). The clock is the test's own (`now` of the plan's work). No git, no Docker, no network.
//
//   pnpm test:file test/resolve-wait-paused.test.ts

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

test("a requeue made during a pause records the resolve's wait from the requeue, less only the pause after it", async () => {
  let clock = 1_000;
  let paused: number | undefined;
  const told: Change<G, string>[] = [];
  const attempts: { id: string; n: number; resolveWaitMs?: number }[] = [];
  const land10 = later();
  const run20 = later();
  const inGates = later();
  let conflicted = false;
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }],
    files: { of: (): TicketFiles => ({ all: ["src/a.ts"], unmergeable: [] }) },
  });
  const running = schedule.run({
    workers: 2,
    now: () => clock,
    pause: { read: () => (paused === undefined ? undefined : { since: paused }), pollMs: 20 },
    attempt: async (t, at) => {
      attempts.push({ id: t.id, n: at.n, resolveWaitMs: at.resolveWaitMs });
      if (t.id === "20") {
        // In its gates for the whole test: 10's resolve waits for it once the run resumes.
        at.gates();
        inGates.open();
        await run20.done;
      }
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && !conflicted) {
        await land10.done;
        conflicted = true;
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => told.push(c),
  });
  await inGates.done;
  paused = Math.floor(Date.now() / 1000);
  await until("the run is paused", () => told.some((c) => c.kind === "paused"));
  // 50 s of the pause pass before 10's landing conflicts: none of them is 10's wait.
  clock += 50_000;
  land10.open();
  await until("10 is sent back during the pause", () => told.some((c) => c.kind === "requeued"));
  // 20 s more of the pause, after the requeue: held by the pause, so left out too.
  clock += 20_000;
  paused = undefined;
  await until("the run resumes", () => told.some((c) => c.kind === "resumed"));
  // The resolve waits for 20, in its gates, for 10 s of the run's time.
  await sleep(100);
  clock += 10_000;
  run20.open();
  await running;
  const second = attempts.filter((a) => a.id === "10" && a.n === 2);
  assert.equal(second.length, 1, JSON.stringify(attempts));
  assert.equal(second[0].resolveWaitMs, 10_000);
});
