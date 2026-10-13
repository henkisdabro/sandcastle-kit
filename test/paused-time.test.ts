// The time a run spends paused, summed by createPauseHandling from the `since` the scheduler tells with `paused` to the
// resume, the stop or the run's end, and told to the port that becomes the run record's `pausedMs`. Driven with fakes
// and a fake clock - no whole run, no Docker, no model, no network.
//
//   pnpm test:file test/paused-time.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { UsagePaused } from "../mod/hooks/run-record.ts";
import { createPauseHandling } from "../src/usage.ts";

const T0 = 1_800_000_000;

const harness = () => {
  let clock = T0;
  const told: number[] = [];
  const handling = createPauseHandling({
    record: () => {},
    say: () => {},
    ref: (id) => id,
    releaseAwake: () => {},
    holdAwake: async () => {},
    refresh: () => {},
    now: () => clock * 1000,
    pausedFor: (ms) => void told.push(ms),
  });
  return { handling, told, at: (seconds: number) => void (clock = seconds) };
};

const usage = (resumesAt: number): UsagePaused => ({ cause: "usage", provider: "claude", window: "week", percent: 96, resumesAt });

test("a pause and its resume tell the span between them", () => {
  const { handling, told, at } = harness();
  handling.told({ kind: "paused", since: T0, finishing: [] });
  assert.deepEqual(told, [], "nothing is told while the pause holds");
  at(T0 + 3600);
  handling.told({ kind: "resumed" });
  assert.deepEqual(told, [3_600_000]);
});

test("a pause from before this turn started counts from the turn's start: an autonomy turn's own time, not the turn before's", () => {
  // The pause file lives until `sandcastle resume`, so the next turn of the same run is told the pause with its first `since`.
  const { handling, told, at } = harness();
  handling.told({ kind: "paused", since: T0 - 1800, finishing: [] });
  at(T0 + 600);
  handling.told({ kind: "resumed" });
  assert.deepEqual(told, [600_000]);
});

test("two pauses sum", () => {
  const { handling, told, at } = harness();
  handling.told({ kind: "paused", since: T0, finishing: [] });
  at(T0 + 600);
  handling.told({ kind: "resumed" });
  at(T0 + 1000);
  handling.told({ kind: "paused", since: T0 + 1000, finishing: [] });
  at(T0 + 1300);
  handling.told({ kind: "resumed" });
  assert.deepEqual(told, [600_000, 900_000]);
});

test("a change of reason in the middle of a pause is the same span", () => {
  const { handling, told, at } = harness();
  handling.told({ kind: "paused", since: T0, finishing: ["7"], usage: usage(T0 + 7200) });
  at(T0 + 100);
  handling.told({ kind: "paused", since: T0, finishing: [] });
  at(T0 + 200);
  handling.told({ kind: "paused", since: T0, finishing: [], usage: usage(T0 + 9000) });
  at(T0 + 1800);
  handling.told({ kind: "resumed" });
  assert.deepEqual(told, [1_800_000]);
});

test("a run that ends paused counts up to the end", async () => {
  const { handling, told, at } = harness();
  handling.told({ kind: "paused", since: T0, finishing: [] });
  at(T0 + 90);
  await handling.end();
  assert.deepEqual(told, [90_000]);
  await handling.end();
  assert.deepEqual(told, [90_000], "a second end adds nothing");
});

test("a stop that ends the pause ends the span", () => {
  const { handling, told, at } = harness();
  handling.told({ kind: "paused", since: T0, finishing: ["3"] });
  at(T0 + 45);
  handling.told({ kind: "pause stopped" });
  assert.deepEqual(told, [45_000]);
});

test("burndown() records the total the pause handling tells", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /pausedFor: \(ms\) => \{\s*pausedMs = ms;\s*run\.update\(\{ pausedMs \}\);/);
  assert.match(src, /\.\.\.\(pausedMs > 0 \? \{ pausedMs \} : \{\}\)/);
});
