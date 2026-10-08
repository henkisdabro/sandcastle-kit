// The run's side of a usage pause (createPauseHandling): what the scheduler's `paused` and `resumed` changes do to
// the run record and keep-awake, and an attempt's wait while the run is paused. Driven with fakes for the record, the
// keep-awake, the view and the log - no whole run, no Docker, no model, no network.
//
//   pnpm test:file test/pause-handling.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsagePaused } from "../mod/hooks/run-record.ts";
import { createPauseHandling } from "../src/usage.ts";

const NOW_SECONDS = 1_800_000_000;

const harness = (nowSeconds = NOW_SECONDS) => {
  const events: string[] = [];
  const said: string[] = [];
  const records: unknown[] = [];
  const handling = createPauseHandling({
    record: (paused) => {
      records.push(paused);
      events.push(paused ? "record paused" : "record cleared");
    },
    say: (line) => said.push(line),
    ref: (id) => `#${id}`,
    releaseAwake: () => events.push("release"),
    holdAwake: async () => {
      events.push("hold");
    },
    refresh: () => events.push("refresh"),
    now: () => nowSeconds * 1000,
  });
  return { handling, events, said, records };
};

const usage: UsagePaused = { cause: "usage", provider: "claude", window: "week", percent: 96, resumesAt: NOW_SECONDS + 3600 };

test("a pause with nothing in flight is in the record and the machine may sleep", () => {
  const { handling, events, said, records } = harness();
  handling.told({ kind: "paused", since: NOW_SECONDS - 60, finishing: [], usage });
  assert.deepEqual(records, [{ since: NOW_SECONDS - 60, finishing: [], ...usage }]);
  assert.deepEqual(events, ["record paused", "release", "refresh"]);
  assert.equal(said.length, 1);
  assert.match(said[0], /paused for plan usage \(weekly usage 96%\).*nothing is in flight/);
});

test("a pause with tickets still finishing keeps the machine awake and names them", () => {
  const { handling, events, said, records } = harness();
  handling.told({ kind: "paused", since: NOW_SECONDS, finishing: ["7", "9"] });
  assert.deepEqual(records, [{ since: NOW_SECONDS, finishing: ["7", "9"] }]);
  assert.deepEqual(events, ["record paused", "refresh"]);
  assert.match(said[0], /paused by `sandcastle pause`.*finishing #7, #9/);
  // The last one reaches its juncture: now nothing is in flight, and the machine may sleep.
  handling.told({ kind: "paused", since: NOW_SECONDS, finishing: [] });
  assert.deepEqual(events, ["record paused", "refresh", "record paused", "release", "refresh"]);
  assert.equal(said.length, 1, "the same cause is said once");
});

test("a pause taken over by a person is said again, and a resume clears the record and holds the machine awake", () => {
  const { handling, events, said, records } = harness();
  handling.told({ kind: "paused", since: NOW_SECONDS, finishing: [], usage });
  handling.told({ kind: "paused", since: NOW_SECONDS, finishing: [] });
  assert.equal(said.length, 2);
  assert.match(said[1], /a person's now/);
  events.length = 0;
  handling.told({ kind: "resumed" });
  assert.equal(records.at(-1), undefined);
  assert.deepEqual(events, ["record cleared", "hold", "refresh"]);
  assert.match(said[2], /^Resumed: each paused ticket goes on from its next phase\.$/);
});

test("a resume after the usage window's reset says the window has reset", () => {
  const { handling, said } = harness(NOW_SECONDS + 7200);
  handling.told({ kind: "paused", since: NOW_SECONDS, finishing: [], usage });
  handling.told({ kind: "resumed" });
  assert.match(said.at(-1) ?? "", /the plan's usage window has reset/);
});

test("a change that is not a pause touches nothing", () => {
  const { handling, events, said } = harness();
  handling.told({ kind: "landing", at: 1, of: 2 });
  assert.deepEqual(events, []);
  assert.deepEqual(said, []);
});

test("a run that ends paused is cleared and held awake, and one that never paused is left alone", async () => {
  const quiet = harness();
  await quiet.handling.end();
  assert.deepEqual(quiet.events, []);

  const { handling, events } = harness();
  handling.told({ kind: "paused", since: NOW_SECONDS, finishing: [] });
  events.length = 0;
  await handling.end();
  assert.deepEqual(events, ["record cleared", "hold"]);
  await handling.end();
  assert.equal(events.length, 2, "a second close does nothing");
});

test("an attempt waits at its start while the run is paused and goes on at the resume", async () => {
  const { handling } = harness();
  // Still paused after the first juncture returns (the pause's cause changed, say): the attempt waits again.
  let pausedFor = 2;
  const phases: string[] = [];
  let released = false;
  await handling.waitOutPause(
    true,
    () => pausedFor > 0,
    async (phase, park) => {
      phases.push(phase);
      // The park a waiting ticket hands in holds nothing: it has no sandbox to close or open.
      await park.suspend();
      await park.resume();
      pausedFor--;
      released = pausedFor === 0;
    },
  );
  assert.deepEqual(phases, ["start", "start"]);
  assert.equal(released, true);
});

test("an attempt does not wait when the run is not paused, or has no usage pause", async () => {
  const { handling } = harness();
  let junctures = 0;
  const juncture = async () => {
    junctures++;
  };
  await handling.waitOutPause(true, () => false, juncture);
  await handling.waitOutPause(false, () => true, juncture);
  assert.equal(junctures, 0);
});
