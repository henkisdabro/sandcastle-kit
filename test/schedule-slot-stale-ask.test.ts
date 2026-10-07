// Slot first (createSchedule in src/schedule.ts): a worker asks the pool for a sandbox slot only while a
// ticket is queued for it. A worker whose ticket went off to wait for its resolve keeps its slot and takes
// the next head itself, so another worker that began asking for that same ticket would go on asking for
// nothing - and beside another run that wants slots, a run with no demand left is never granted one, so its
// schedule never ended. Driven through the scheduler's ports with a made-up slot pool, files and fake work.
// No git, no Docker, no network.
//
//   node --test test/schedule-slot-stale-ask.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Landed } from "../src/landing.ts";
import { type Slot, createSchedule, type TicketFiles } from "../src/schedule.ts";

type T = { id: string };
type G = { issue: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 2000; i++) {
    if (ok()) return;
    await sleep(2);
  }
  assert.fail(`timed out waiting for ${what}`);
};
const filesOf = (by: Record<string, string[]>) => ({ of: (t: T): TicketFiles => ({ all: by[t.id] ?? [], unmergeable: [] }) });

test("a worker stops asking for a slot once the ticket it asked for was taken by a worker that already held one", async () => {
  // The pool: a slot is granted only when the test says so, the oldest ask first; an ask whose `wanted()` turns false ends with none.
  const asks: { grant(): void }[] = [];
  let open = false;
  const grant = () => asks.shift()?.grant();
  const slot = (wanted: () => boolean) =>
    new Promise<Slot | undefined>((resolve) => {
      const ask = {
        grant: () => {
          clearInterval(timer);
          resolve({ release: () => {} });
        },
      };
      const timer = setInterval(() => {
        if (wanted()) return;
        clearInterval(timer);
        asks.splice(asks.indexOf(ask), 1);
        resolve(undefined);
      }, 2);
      if (open) ask.grant();
      else asks.push(ask);
    });

  const order: string[] = [];
  let finish20!: () => void;
  const twenty = new Promise<void>((resolve) => (finish20 = resolve));
  let conflicted = false;
  const schedule = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "20" }, { id: "30" }],
    files: filesOf({ 10: ["src/a.ts"], 20: ["src/a.ts", "src/b.ts"], 30: ["src/c.ts"] }),
  });
  const running = schedule.run({
    workers: 3,
    slot,
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (t.id === "20") await twenty;
      return { kind: "green", green: { issue: t.id } };
    },
    land: async (g) => {
      if (g.issue === "10" && !conflicted) {
        conflicted = true;
        return { kind: "conflict", files: ["src/a.ts"], with: [] } satisfies Landed;
      }
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });

  // Three workers ask for the three tickets: 10 and 20 start, the third worker still asks for 30.
  await until(() => asks.length === 3, "every worker to ask for a slot");
  grant();
  grant();
  await until(() => order.includes("start 20 #1"), "20 to start");
  // 10 conflicts at landing and is sent back while 20, on the file it conflicted on, still runs: its worker asks too.
  await until(() => asks.length === 2, "10's worker to ask for a slot for the requeued ticket");
  // The worker that asked for 30 gets the slot, takes 10 (requeued, first in line), which goes off to wait for 20,
  // and keeps the slot for 30. Nothing is queued now: the other worker's ask is for nothing.
  grant();
  await until(() => order.includes("start 30 #1"), "30 to start in the slot 10's resolve left");
  let stale = true;
  for (let i = 0; i < 100 && stale; i++) {
    await sleep(2);
    stale = asks.length > 0;
  }
  // Let the run end either way: 20 finishes, 10's resolve runs.
  open = true;
  while (asks.length) grant();
  finish20();
  const { endings } = await running;
  assert.equal(stale, false, "a worker went on asking the pool for a slot with no ticket queued");
  assert.ok(order.includes("start 10 #2"), order.join(" | "));
  for (const id of ["10", "20", "30"]) assert.equal(endings.get(id)?.kind, "landing", id);
});
