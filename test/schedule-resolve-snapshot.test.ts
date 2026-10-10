// A sent-back ticket's resolve waits for the tickets that were ahead of it when the wait began, and
// no ticket that starts after: the run keeps starting tickets, and a wait that follows them can
// outlast the queue (createSchedule in src/schedule.ts). Driven through the scheduler's ports with
// made-up files and fake work. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-resolve-snapshot.test.ts

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
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ok(), what);
};

test("a resolve does not wait for a ticket that shares its file but started after the wait began", async () => {
  const run20 = later();
  const run30 = later();
  const sentBack = later();
  const started: string[] = [];
  const attempts: string[] = [];
  let conflicted = false;
  const schedule = createSchedule<T, G, string>({
    // 15 holds the worker that would start 30 until 10 is sent back: 30 starts after the resolve's wait began.
    tickets: [{ id: "10" }, { id: "20" }, { id: "15" }, { id: "30" }],
    files: { of: (t: T): TicketFiles => ({ all: [t.id === "15" ? "src/other.ts" : "src/a.ts"], unmergeable: [] }) },
  });
  const running = schedule.run({
    workers: 2,
    attempt: async (t, at) => {
      attempts.push(`${t.id}#${at.n}`);
      started.push(t.id);
      if (t.id === "20") await run20.done;
      if (t.id === "15") {
        await sentBack.done;
        // Time for 10 to be queued again and taken by the free worker before 30.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // 30 starts once 10 is sent back and waiting, and stays in its pipeline well past 20's landing.
      if (t.id === "30") await run30.done;
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && !conflicted) {
        conflicted = true;
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      if (c.kind === "requeued") sentBack.open();
    },
  });
  await until("30 started while 10 waits for 20", () => started.includes("30"));
  assert.deepEqual(attempts, ["10#1", "20#1", "15#1", "30#1"]);
  // 20 lands: the resolve's whole snapshot has gone, so 10 begins again with 30 still working.
  run20.open();
  await until("10 resolves behind 20 alone", () => attempts.includes("10#2"));
  run30.open();
  const { endings } = await running;
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
});

test("a resolve still waits for a ticket at work when its wait began, once that ticket's branch is queued to land", async () => {
  const run20 = later();
  const run30 = later();
  const land30 = later();
  const sentBack = later();
  const started: string[] = [];
  const attempts: string[] = [];
  const landing: string[] = [];
  let conflicted = false;
  const files: Record<string, string[]> = { "10": ["src/a.ts", "src/b.ts"], "20": ["src/a.ts"], "30": ["src/b.ts"] };
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }, { id: "30" }],
    files: { of: (t: T): TicketFiles => ({ all: files[t.id], unmergeable: [] }) },
  });
  const running = schedule.run({
    workers: 3,
    attempt: async (t, at) => {
      attempts.push(`${t.id}#${at.n}`);
      started.push(t.id);
      // 20 shares the file 10 conflicts on and leaves the run red; 30 shares only the other file, and goes green later.
      if (t.id === "20") {
        await run20.done;
        return { kind: "pipeline", outcome: "red" };
      }
      if (t.id === "30") await run30.done;
      return green(t.id);
    },
    land: async (g) => {
      landing.push(g.issue);
      if (g.issue === "10" && !conflicted) {
        // Both others are at work when 10 conflicts, so both were ahead of it when its wait began.
        await until("20 and 30 started", () => started.includes("20") && started.includes("30"));
        conflicted = true;
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      if (g.issue === "30") await land30.done;
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      if (c.kind === "requeued") sentBack.open();
    },
  });
  await sentBack.done;
  run30.open();
  await until("30 queued to land", () => landing.includes("30"));
  run20.open();
  // 20 has left; 30's branch, which shares 10's other file, is still landing: 10 waits for it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!attempts.includes("10#2"), `10 resolved with 30 still queued to land: ${attempts.join(" ")}`);
  land30.open();
  await until("10 resolves once 30 has landed", () => attempts.includes("10#2"));
  const { endings } = await running;
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
});
