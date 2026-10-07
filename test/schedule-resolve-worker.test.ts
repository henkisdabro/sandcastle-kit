// A sent-back ticket waiting to resolve its conflict holds no pipeline worker (createSchedule in
// src/schedule.ts): another ticket starts in that worker while the resolve waits, and the resolve
// still runs once the ticket ahead of it has landed. Driven through the scheduler's ports with made-up
// files and fake work. No git, no Docker, no network.
//
//   node --test test/schedule-resolve-worker.test.ts

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
const filesOf = (by: Record<string, string[]>) => ({ of: (t: T): TicketFiles => ({ all: by[t.id] ?? [], unmergeable: [] }) });

test("a sent-back ticket waiting for the ticket ahead of its resolve leaves its worker to the tickets behind it", async () => {
  const order: string[] = [];
  const told: Change<G, string>[] = [];
  const requeued = later();
  const fortyStarted = later();
  const first = { landed: false };
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }, { id: "30" }, { id: "40" }],
    files: filesOf({ 10: ["src/a.ts"], 20: ["src/a.ts", "src/b.ts"], 30: ["src/c.ts"], 40: ["src/d.ts"] }),
  });
  const { endings } = await schedule.run({
    workers: 2,
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (t.id === "20") {
        // Still running, on the file 10 conflicted on, until 40 has started - or a moment passes, as it would
        // if 10's resolve kept a worker and 40 had none: the order below then shows 20 ending first.
        await Promise.race([fortyStarted.done, new Promise((resolve) => setTimeout(resolve, 300))]);
      }
      if (t.id === "30") await requeued.done;
      if (t.id === "40") fortyStarted.open();
      order.push(`end ${t.id} #${at.n}`);
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue === "10" && !first.landed) {
        first.landed = true;
        order.push("land 10 conflict");
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      order.push(`land ${g.issue} merged`);
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      told.push(c);
      if (c.kind === "requeued") requeued.open();
    },
  });
  // 40 starts while 10 waits for 20, and 10's second attempt begins only after 20 has landed.
  assert.ok(order.indexOf("start 40 #1") < order.indexOf("end 20 #1"), order.join(" | "));
  assert.ok(order.indexOf("land 20 merged") < order.indexOf("start 10 #2"), order.join(" | "));
  // The wait was shorter than the settling, so the run never said it: nor says it resolves now.
  assert.equal(told.some((c) => c.kind === "resolve waits" || c.kind === "resolve starts"), false);
  for (const id of ["10", "20", "30", "40"]) assert.equal(endings.get(id)?.kind, "landing", id);
  assert.equal((endings.get("10") as { landed: Landed }).landed.kind, "merged");
  assert.equal(order.filter((o) => o === "land 10 merged").length, 1);
});
