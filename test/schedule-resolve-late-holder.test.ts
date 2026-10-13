// A ticket that starts after a sent-back ticket's resolve began to wait, and reaches its gates while that
// wait is on, holds the resolve until it has landed: whenever a ticket started, past its review it is a
// gate run and a landing from the base the resolve merges (createSchedule in src/schedule.ts). Driven
// through the scheduler's ports with made-up files and fake work, and burndown.ts's call held by its source.
// No git, no Docker, no network.
//
//   pnpm test:file test/schedule-resolve-late-holder.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await sleep(20);
  assert.ok(ok(), what);
};

test("a ticket started after a resolve's wait began holds it from its gates until it has landed", async () => {
  const order: string[] = [];
  const twentyInGates = later();
  const run20 = later();
  const gates30 = later();
  const run30 = later();
  const sentBack = later();
  let conflicted = false;
  const schedule = createSchedule<T, G, string>({
    // 10, 20 and 30 share a.ts. Two workers: 15 holds the one 10 frees until 10 is sent back, so 10 is taken again
    // first, goes off to wait for 20, and 30 takes the worker it leaves: 30 starts after the wait began.
    tickets: [{ id: "10" }, { id: "20" }, { id: "15" }, { id: "30" }],
    files: { of: (t: T): TicketFiles => ({ all: [t.id === "15" ? "src/other.ts" : "src/a.ts"], unmergeable: [] }) },
  });
  const running = schedule.run({
    workers: 2,
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (t.id === "20") {
        at.gates();
        twentyInGates.open();
        await run20.done;
      }
      if (t.id === "15") {
        await sentBack.done;
        await sleep(100);
      }
      if (t.id === "30") {
        // Implementing (no hold on 10) until the test lets it reach its gates.
        await gates30.done;
        at.gates();
        order.push("gates 30");
        await run30.done;
      }
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && !conflicted) {
        await twentyInGates.done;
        conflicted = true;
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      order.push(`land ${g.issue}`);
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      if (c.kind === "requeued") {
        order.push(`requeued ${c.id}`);
        sentBack.open();
      }
    },
  });
  await until("30 starts once 10 waits for 20", () => order.includes("start 30 #1"));
  assert.ok(order.indexOf("requeued 10") < order.indexOf("start 30 #1"), order.join(" | "));
  gates30.open();
  await until("30 in its gates", () => order.includes("gates 30"));
  run20.open();
  await until("20 lands", () => order.includes("land 20"));
  // 20 has landed, but 30 is in its gates on the same file: 10's resolve waits for it.
  await sleep(300);
  assert.equal(order.includes("start 10 #2"), false, order.join(" | "));
  run30.open();
  const { endings } = await running;
  assert.ok(order.indexOf("land 30") < order.indexOf("start 10 #2"), order.join(" | "));
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
});

test("a ticket's pipeline tells the scheduler it is in its gates before its gate run", () => {
  // burndown() needs Docker: its call is held by its text. Without it no ticket ever holds a resolve from its gates.
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /\n\s+at\?\.gates\?\.\(\);\n\s+let gated: GateRun;\n/);
  assert.match(source, /pipeline\(issue, \{ juncture: [^\n]*, paused, gates, resolveWaitMs \}\)/);
});
