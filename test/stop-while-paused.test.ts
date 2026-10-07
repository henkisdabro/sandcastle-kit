// A stop that arrives while the run is paused wakes every parked ticket: the pause would otherwise
// last until the plan's window resets - possibly days - with the stop unreported and nothing more able
// to happen. A parked ticket that wakes to a stop ends as parked (its branch holds every commit, its
// sandbox stays closed) and the closing summary lists it under Runnable now, as for a run stopped while paused.
//
// The scheduler is driven through its ports (`createSchedule` with fake attempt and land ports, a pause
// source and a host whose write the test refuses); the summary through `render`. No Docker, no model, no network.
//
//   node --test test/stop-while-paused.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createSchedule } = await import("../src/schedule.ts");
const { render } = await import("../src/report.ts");
type Change = import("../src/schedule.ts").Change<G, string, string>;
type Facts = import("../src/report.ts").Facts;

type T = { id: string };
type G = { issue: string };

const green = (id: string) => ({ kind: "green", green: { issue: id } }) as const;
const merged = async () => ({ kind: "merged" }) as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};
/** The pause as the run reads it, asked and lifted by the test; polled every few milliseconds. */
const control = () => {
  let since: number | undefined;
  return {
    source: { read: () => (since === undefined ? undefined : { since }), pollMs: 5 },
    pause: () => void (since = 1_790_000_000),
    resume: () => void (since = undefined),
  };
};
/** A host that fails a write when the test says so: a safety stop nobody records, read live. */
const refusingHost = () => {
  const host: { check(ticket: string): Promise<void>; failed: unknown } = { check: async () => {}, failed: undefined };
  return { host, refuse: () => void (host.failed = new Error("STOPPED before writing to the base branch: .git/config changed while sandboxes ran")) };
};

test("a stop while two tickets are parked by a pause ends both as parked within a poll, with no sandbox reopened", async () => {
  const pause = control();
  const { host, refuse } = refusingHost();
  const log: string[] = [];
  const told: Change[] = [];
  const implemented = gate();
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }, { id: "2" }] }).run({
    workers: 2,
    pause: pause.source,
    attempt: async (t, at) => {
      log.push(`start ${t.id}`);
      await implemented.opened;
      await at.juncture("review", {
        suspend: async () => void log.push(`sandbox ${t.id} closed`),
        resume: async () => void log.push(`sandbox ${t.id} opened`),
      });
      log.push(`review ${t.id}`);
      return green(t.id);
    },
    land: async (g) => (log.push(`land ${g.issue}`), merged()),
    host,
    tell: (c) => void told.push(c),
  });
  let over = false;
  void done.then(() => (over = true));

  await until(() => log.includes("start 1") && log.includes("start 2"), "both tickets to start");
  pause.pause();
  await until(() => told.some((c) => c.kind === "paused"), "the pause to be told");
  implemented.open();
  await until(() => log.includes("sandbox 1 closed") && log.includes("sandbox 2 closed"), "both tickets to park");
  await sleep(30);
  assert.equal(over, false, "a paused run does not end by itself");

  refuse();
  const { endings, stop } = await Promise.race([done, sleep(2000).then(() => assert.fail("the run stayed paused after the stop"))]);

  assert.deepEqual(
    ["1", "2"].map((id) => endings.get(id)?.kind),
    ["parked", "parked"],
  );
  assert.equal(stop.landsNothing, true);
  assert.deepEqual(log.filter((l) => !l.endsWith("closed") && !l.startsWith("start")), [], "no sandbox reopened, no pass began, nothing landed");
  assert.ok(!told.some((c) => c.kind === "resumed"), "the pause was never lifted: the stop ended it");
  assert.equal(told.filter((c) => c.kind === "stopped landing").length, 1, "the stop is told once, the moment it holds");
});

test("a stop ends a ticket parked at its start as not begun, and one parked at a juncture as parked", async () => {
  const pause = control();
  const { host, refuse } = refusingHost();
  const log: string[] = [];
  const implemented = gate();
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }, { id: "2" }] }).run({
    workers: 1,
    pause: pause.source,
    attempt: async (t, at) => {
      log.push(`start ${t.id}`);
      await implemented.opened;
      await at.juncture("review", { suspend: async () => void log.push(`sandbox ${t.id} closed`), resume: async () => void log.push(`sandbox ${t.id} opened`) });
      return green(t.id);
    },
    land: merged,
    host,
    tell: () => {},
  });
  await until(() => log.includes("start 1"), "ticket 1 to start");
  pause.pause();
  implemented.open();
  await until(() => log.includes("sandbox 1 closed"), "ticket 1 to park");
  refuse();
  const { endings } = await Promise.race([done, sleep(2000).then(() => assert.fail("the run stayed paused after the stop"))]);
  assert.equal(endings.get("1")?.kind, "parked");
  assert.equal(endings.get("2")?.kind, "not begun");
  assert.deepEqual(log, ["start 1", "sandbox 1 closed"]);
});

test("a pause that ends normally still resumes both parked tickets", async () => {
  const pause = control();
  const log: string[] = [];
  const implemented = gate();
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }, { id: "2" }] }).run({
    workers: 2,
    pause: pause.source,
    attempt: async (t, at) => {
      log.push(`start ${t.id}`);
      await implemented.opened;
      await at.juncture("review", {
        suspend: async () => void log.push(`sandbox ${t.id} closed`),
        resume: async () => void log.push(`sandbox ${t.id} opened`),
      });
      log.push(`review ${t.id}`);
      return green(t.id);
    },
    land: merged,
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  await until(() => log.includes("start 1") && log.includes("start 2"), "both tickets to start");
  pause.pause();
  await sleep(20);
  implemented.open();
  await until(() => log.includes("sandbox 1 closed") && log.includes("sandbox 2 closed"), "both tickets to park");
  await sleep(30);
  assert.ok(!log.some((l) => l.startsWith("review")), "nothing resumed while paused");
  pause.resume();
  const { endings } = await done;
  assert.deepEqual([...endings].map(([id, e]) => `${id} ${e.kind}`).sort(), ["1 landing", "2 landing"]);
  assert.deepEqual(log.filter((l) => l.startsWith("review")).sort(), ["review 1", "review 2"]);
  assert.ok(log.includes("sandbox 1 opened") && log.includes("sandbox 2 opened"));
});

const facts = (over: Partial<Facts>): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:41:00.000Z",
  finished: "2026-10-05T07:10:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: {
    "57": { state: "paused", title: "wordWrap", started: 1, note: "before review at a1b2c3d" },
    "58": { state: "paused", title: "median", started: 1, note: "before repair at 9f8e7d6" },
  },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "running",
  exitCode: 1,
  stopped: "STOPPED before writing to the base branch: .git/config changed while sandboxes ran",
  ...over,
});

test("the summary of a run stopped by its guard while paused lists the parked tickets under Runnable now", () => {
  const out = render(facts({}), true);
  const left = out.split("## Runnable now / Still blocked")[1]?.split("\n## ")[0] ?? "";
  assert.match(left, /Runnable now: #57 \(paused before review at a1b2c3d - its branch resumes\), #58 \(paused before repair at 9f8e7d6 - its branch resumes\)/);
  assert.doesNotMatch(left, /Cut short/);
});
