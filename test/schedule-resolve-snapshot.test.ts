// A sent-back ticket's resolve waits only for the tickets past their review - in their gates, or green and
// queued to land - that share its files, whenever they started; a ticket still implementing never holds
// it (createSchedule in src/schedule.ts). Driven through the scheduler's ports with made-up files and
// fake work. No git, no Docker, no network.
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

test("a resolve does not wait for a ticket that shares its file and is still implementing, whether it started before the wait or after", async () => {
  const run20 = later();
  const run30 = later();
  const sentBack = later();
  const attempts: string[] = [];
  let conflicted = false;
  const schedule = createSchedule<T, G, string>({
    // 15 holds the worker that would start 30 until 10 is sent back: 30 starts after the resolve could have waited.
    tickets: [{ id: "10" }, { id: "20" }, { id: "15" }, { id: "30" }],
    files: { of: (t: T): TicketFiles => ({ all: [t.id === "15" ? "src/other.ts" : "src/a.ts"], unmergeable: [] }) },
  });
  const running = schedule.run({
    workers: 2,
    attempt: async (t, at) => {
      attempts.push(`${t.id}#${at.n}`);
      if (t.id === "20") await run20.done;
      if (t.id === "15") {
        await sentBack.done;
        // Time for 10 to be queued again and taken by the free worker before 30.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
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
  // 20 never reached its gates, and 30 never started before the resolve: 10 resolves with both still at work.
  await until("10 resolves with 20 implementing", () => attempts.includes("10#2"));
  assert.ok(!attempts.includes("30#1") || attempts.indexOf("10#2") < attempts.indexOf("30#1"), attempts.join(" "));
  run20.open();
  await until("30 starts", () => attempts.includes("30#1"));
  run30.open();
  const { endings } = await running;
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
});

test("a resolve waits for a ticket in its gates that started after the wait began, until it has landed", async () => {
  const run30 = later();
  const land30 = later();
  const sentBack = later();
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
      // 20 shares the file 10 conflicts on and stays at work (implementing); 30 shares only the other file, and is in its gates.
      if (t.id === "20") await new Promise((resolve) => setTimeout(resolve, 600));
      if (t.id === "30") {
        at.gates();
        await run30.done;
      }
      return green(t.id);
    },
    land: async (g) => {
      landing.push(g.issue);
      if (g.issue === "10" && !conflicted) {
        // 30 is in its gates when 10 conflicts.
        await until("20 and 30 started", () => attempts.includes("20#1") && attempts.includes("30#1"));
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
  // 30 is only in its gates, and the resolve waits for it; 20, still implementing, does not hold it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!attempts.includes("10#2"), `10 resolved with 30 in its gates: ${attempts.join(" ")}`);
  run30.open();
  await until("30 queued to land", () => landing.includes("30"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!attempts.includes("10#2"), `10 resolved with 30 still queued to land: ${attempts.join(" ")}`);
  land30.open();
  await until("10 resolves once 30 has landed", () => attempts.includes("10#2"));
  const { endings } = await running;
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
});
