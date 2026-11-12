// Released resolves that share a file go one at a time: two sent-back tickets freed by one landing, on
// the same file, were released together, and the second then conflicted with the first at landing and
// needed a third attempt. The one sent back first goes first and the other waits for its landing; two
// that share no file are released together (createSchedule in src/schedule.ts). Driven through the
// scheduler's ports with made-up files and fake work. No git, no Docker, no network.
//
//   pnpm test:file test/schedule-resolve-one-at-a-time.test.ts

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await sleep(20);
  assert.ok(ok(), what);
};

// Three workers. 10 and 11 go green and conflict at their landings, in that order, while 20 is in its gates: both are
// sent back and wait for 20, which shares a file with each. 20 then goes green and waits, queued to land, until
// `land20`; each resolve's own landing waits for `resolved`.
const play = (by: Record<string, string[]>, resolved: (order: string[]) => Promise<void>) => {
  const order: string[] = [];
  const inGates = later();
  const run20 = later();
  const land20 = later();
  const conflicted = new Set<string>();
  const running = createSchedule<T, G, string>({
    tickets: [{ id: "10" }, { id: "11" }, { id: "20" }],
    files: { of: (t: T): TicketFiles => ({ all: by[t.id]!, unmergeable: [] }) },
  }).run({
    workers: 3,
    attempt: async (t, at) => {
      order.push(`start ${t.id} #${at.n}`);
      if (t.id === "20") {
        at.gates();
        inGates.open();
        await run20.done;
      }
      return green(t.id);
    },
    land: async (g) => {
      if (g.issue !== "20" && !conflicted.has(g.issue)) {
        await inGates.done;
        conflicted.add(g.issue);
        return { kind: "conflict", files: by[g.issue]!, with: [] } satisfies Landed;
      }
      if (g.issue === "20") await land20.done;
      else await resolved(order);
      order.push(`land ${g.issue}`);
      return { kind: "merged" } satisfies Landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      if (c.kind === "requeued") order.push(`requeued ${c.id}`);
    },
  });
  return { order, running, run20, land20 };
};

test("of two resolves one landing frees on a shared file, the one sent back first starts and the other waits for its landing", async () => {
  const landTen = later();
  const p = play({ 10: ["src/a.ts"], 11: ["src/a.ts"], 20: ["src/a.ts"] }, async () => {
    await landTen.done;
  });
  await until("both sent back", () => p.order.includes("requeued 11"));
  assert.ok(p.order.indexOf("requeued 10") < p.order.indexOf("requeued 11"), p.order.join(" | "));
  p.run20.open();
  await sleep(300);
  // 20 is queued to land: neither resolve starts before it has.
  assert.equal(p.order.some((o) => o.endsWith("#2")), false, p.order.join(" | "));
  p.land20.open();
  await until("10's resolve starts", () => p.order.includes("start 10 #2"));
  // 10's resolve is under way, its landing held: 11 shares its file and waits for it.
  await sleep(300);
  assert.equal(p.order.includes("start 11 #2"), false, p.order.join(" | "));
  landTen.open();
  const { endings } = await p.running;
  assert.ok(p.order.indexOf("land 20") < p.order.indexOf("start 10 #2"), p.order.join(" | "));
  assert.ok(p.order.indexOf("land 10") < p.order.indexOf("start 11 #2"), p.order.join(" | "));
  for (const id of ["10", "11", "20"]) assert.equal((endings.get(id) as { landed: Landed }).landed.kind, "merged", id);
});

test("two resolves that share no file are released together by the landing they both waited for", async () => {
  const p = play({ 10: ["src/a.ts"], 11: ["src/b.ts"], 20: ["src/a.ts", "src/b.ts"] }, async (order) => {
    // Neither resolve lands until both have started: one held behind the other would never let this pass.
    await until("both resolves start", () => order.includes("start 10 #2") && order.includes("start 11 #2"));
  });
  await until("both sent back", () => p.order.includes("requeued 11"));
  p.run20.open();
  p.land20.open();
  const { endings } = await p.running;
  for (const id of ["10", "11"]) assert.ok(p.order.indexOf(`start ${id} #2`) < p.order.indexOf("land 10"), p.order.join(" | "));
  for (const id of ["10", "11", "20"]) assert.equal((endings.get(id) as { landed: Landed }).landed.kind, "merged", id);
});
