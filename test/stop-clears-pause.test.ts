// A stop that arrives while the run is paused clears the run record's `paused` at once, while the
// tickets in flight are still finishing: the Herdr sidebar and tab bar read `paused` from the record
// and would otherwise say paused until the schedule ended. The scheduler tells the clearing (once, and
// never a later "paused" for the tickets finishing), the run's pause handling writes it.
//
// The scheduler is driven through its ports (fake attempt and land ports, a pause source, a host whose
// write the test refuses) and the pause handling through the real `createPauseHandling` over a fake
// record. No Docker, no model, no network.
//
//   node --test test/stop-clears-pause.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createSchedule } = await import("../src/schedule.ts");
const { createPauseHandling } = await import("../src/usage.ts");
type G = { issue: string };
type Change = import("../src/schedule.ts").Change<G, string, string>;

type T = { id: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

test("a stop during a pause clears the record's paused before the tickets in flight end, and nothing writes it again", async () => {
  let since: number | undefined;
  const host: { check(ticket: string): Promise<void>; failed: unknown } = { check: async () => {}, failed: undefined };
  // The run record's `paused` and every write to it, in order, with the tickets that had ended at each write.
  const record: { paused: unknown; writes: string[] } = { paused: undefined, writes: [] };
  const ended: string[] = [];
  const handling = createPauseHandling({
    record: (paused) => {
      record.paused = paused;
      record.writes.push(`${paused ? "paused" : "cleared"} after ${ended.length} ended`);
    },
    say: () => {},
    ref: (id) => `#${id}`,
    releaseAwake: () => {},
    holdAwake: async () => {},
    refresh: () => {},
  });
  const told: Change[] = [];
  let passEnds!: () => void;
  const passEnding = new Promise<void>((resolve) => (passEnds = resolve));
  let started = 0;

  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }, { id: "2" }, { id: "3" }] }).run({
    workers: 3,
    pause: { read: () => (since === undefined ? undefined : { since }), pollMs: 5 },
    attempt: async (t) => {
      started++;
      // Inside an agent pass: a pause lets it finish, and so does a stop.
      await passEnding;
      return { kind: "green", green: { issue: t.id } };
    },
    land: async () => ({ kind: "merged" }),
    host,
    tell: (c) => {
      told.push(c);
      if (c.kind === "ended") ended.push(c.id);
      handling.told(c);
    },
  });

  await until(() => started === 3, "all three tickets to start");
  since = 1_790_000_000;
  await until(() => record.paused !== undefined, "the pause to be in the record");
  assert.deepEqual((record.paused as { finishing: string[] }).finishing.sort(), ["1", "2", "3"]);

  host.failed = new Error("STOPPED before writing to the base branch: .git/config changed while sandboxes ran");
  await until(() => record.paused === undefined, "the stop to clear the record");
  assert.equal(ended.length, 0, "cleared while every ticket is still in flight");

  passEnds();
  await done;
  await sleep(30);
  assert.equal(record.paused, undefined, "the record was not written paused again");
  assert.deepEqual(record.writes, ["paused after 0 ended", "cleared after 0 ended"]);
  assert.ok(!told.some((c) => c.kind === "resumed"), "the pause was not lifted: the stop ended it");
});

test("a stop before the pause is read leaves the record unpaused", async () => {
  const host: { check(ticket: string): Promise<void>; failed: unknown } = { check: async () => {}, failed: new Error("STOPPED") };
  const writes: unknown[] = [];
  const handling = createPauseHandling({ record: (p) => void writes.push(p), say: () => {}, ref: (id) => id, releaseAwake: () => {}, holdAwake: async () => {}, refresh: () => {} });
  await createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    pause: { read: () => ({ since: 1_790_000_000 }), pollMs: 5 },
    attempt: async (t) => ({ kind: "green", green: { issue: t.id } }),
    land: async () => ({ kind: "merged" }),
    host,
    tell: (c) => handling.told(c),
  });
  assert.ok(!writes.some((p) => p !== undefined), "no paused record after a stop");
});

test("a resume read after a stop during a pause says no pause lifted", async () => {
  let since: number | undefined;
  const host: { check(ticket: string): Promise<void>; failed: unknown } = { check: async () => {}, failed: undefined };
  const said: string[] = [];
  const handling = createPauseHandling({ record: () => {}, say: (line) => void said.push(line), ref: (id) => id, releaseAwake: () => {}, holdAwake: async () => {}, refresh: () => {} });
  const told: Change[] = [];
  let passEnds!: () => void;
  const passEnding = new Promise<void>((resolve) => (passEnds = resolve));
  let started = false;
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    pause: { read: () => (since === undefined ? undefined : { since }), pollMs: 5 },
    attempt: async (t) => {
      started = true;
      await passEnding;
      return { kind: "green", green: { issue: t.id } };
    },
    land: async () => ({ kind: "merged" }),
    host,
    tell: (c) => {
      told.push(c);
      handling.told(c);
    },
  });

  await until(() => started, "the ticket to start");
  since = 1_790_000_000;
  await until(() => told.some((c) => c.kind === "paused"), "the pause to be told");
  host.failed = new Error("STOPPED before writing to the base branch: .git/config changed while sandboxes ran");
  await until(() => told.some((c) => c.kind === "pause stopped"), "the stop to end the pause");
  // `sandcastle resume` while the ticket in flight finishes: the polls read it before the schedule ends.
  since = undefined;
  await sleep(50);
  passEnds();
  await done;
  assert.ok(!told.some((c) => c.kind === "resumed"), "no resume told after the stop ended the pause");
  assert.ok(!said.some((line) => line.startsWith("Resumed")), "the log says no paused ticket goes on");
});
