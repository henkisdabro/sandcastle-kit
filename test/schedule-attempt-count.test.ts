// The scheduler's attempt count and its stop at a ticket's start (createSchedule in src/schedule.ts):
// a third attempt, which a landing that finished after a resolve began allows, records 3 and not 2;
// and a stop that wakes an attempt parked at its "start" juncture, before any step, ends the ticket as
// not begun - a requeued one keeps its landing - not as parked. The scheduler is driven through its
// ports with fake attempts and landings. No Docker, no model, no network.
//
//   pnpm test:file test/schedule-attempt-count.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createSchedule } = await import("../src/schedule.ts");

type T = { id: string };
type G = { issue: string };

const green = (id: string) => ({ kind: "green", green: { issue: id } }) as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("a ticket sent back twice records three attempts when it lands on the third", async () => {
  const log: string[] = [];
  const landed = new Set<string>();
  const lands: Record<string, number> = {};
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }, { id: "2" }, { id: "3" }] }).run({
    workers: 3,
    attempt: async (t, at) => {
      log.push(`attempt ${t.id}#${at.n}`);
      // 2 meets 1; its second try runs while 3 lands, so the second try meets 3, which its resolve could not hold.
      if (t.id === "2" && at.n === 1) await until(() => landed.has("1"), "1 to land");
      if (t.id === "2" && at.n === 2) await until(() => landed.has("3"), "3 to land");
      if (t.id === "3") await until(() => log.includes("attempt 2#2"), "2's second attempt to begin");
      return green(t.id);
    },
    land: async (g) => {
      lands[g.issue] = (lands[g.issue] ?? 0) + 1;
      if (g.issue === "2" && lands["2"] === 1) return { kind: "conflict", files: ["a.txt"], with: ["1"] } as const;
      if (g.issue === "2" && lands["2"] === 2) return { kind: "conflict", files: ["b.txt"], with: ["3"] } as const;
      landed.add(g.issue);
      return { kind: "merged" } as const;
    },
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  const { endings } = await done;
  const two = endings.get("2");
  assert.equal(two?.kind, "landing");
  assert.equal(two?.kind === "landing" && two.landed.kind, "merged");
  assert.equal(two?.kind === "landing" && two.attempts, 3);
  assert.deepEqual(log.filter((l) => l.startsWith("attempt 2")), ["attempt 2#1", "attempt 2#2", "attempt 2#3"]);
});

const control = () => {
  let since: number | undefined;
  return { source: { read: () => (since === undefined ? undefined : { since }), pollMs: 5 }, pause: () => void (since = 1_790_000_000) };
};
const refusingHost = () => {
  const host: { check(ticket: string): Promise<void>; failed: unknown } = { check: async () => {}, failed: undefined };
  return { host, refuse: () => void (host.failed = new Error("STOPPED before writing to the base branch: .git/config changed while sandboxes ran")) };
};

test("a stop at a first attempt's start wait ends the ticket as not begun, not parked", async () => {
  const pause = control();
  const { host, refuse } = refusingHost();
  const log: string[] = [];
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    pause: pause.source,
    attempt: async (t, at) => {
      log.push(`start ${t.id}`);
      pause.pause();
      await at.juncture("start", { suspend: async () => void log.push("closed"), resume: async () => void log.push("opened") });
      log.push("step");
      return green(t.id);
    },
    land: async () => ({ kind: "merged" }) as const,
    host,
    tell: () => {},
  });
  await until(() => log.includes("start 1"), "the attempt to start");
  await sleep(30);
  refuse();
  const { endings } = await Promise.race([done, sleep(2000).then(() => assert.fail("the run stayed paused after the stop"))]);
  assert.equal(endings.get("1")?.kind, "not begun");
  assert.deepEqual(log, ["start 1", "closed"]);
});

test("a stop at a requeued ticket's start wait leaves its first landing as its ending", async () => {
  const pause = control();
  const { host, refuse } = refusingHost();
  const log: string[] = [];
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    pause: pause.source,
    attempt: async (t, at) => {
      log.push(`attempt ${t.id}#${at.n}`);
      if (at.n === 2) {
        pause.pause();
        await at.juncture("start", { suspend: async () => {}, resume: async () => {} });
        log.push("step");
      }
      return green(t.id);
    },
    land: async () => ({ kind: "conflict", files: ["a.txt"], with: ["9"] }) as const,
    host,
    tell: () => {},
  });
  await until(() => log.includes("attempt 1#2"), "the second attempt to start");
  await sleep(30);
  refuse();
  const { endings } = await Promise.race([done, sleep(2000).then(() => assert.fail("the run stayed paused after the stop"))]);
  const one = endings.get("1");
  assert.equal(one?.kind, "landing");
  assert.equal(one?.kind === "landing" && one.landed.kind, "conflict");
  assert.equal(one?.kind === "landing" && one.attempts, 1);
  assert.ok(!log.includes("step"));
});
