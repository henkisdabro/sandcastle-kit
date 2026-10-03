// The closing summary names the run settings its record carries, and the one switch the run's own
// facts call for: autonomy 0 that left tickets it could run again, a usage guard with no reading.
// A record without a settings group (an older kit's) is unknown, and says nothing.
//
//   pnpm exec tsx --test test/report-settings.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunSettings } from "../mod/hooks/run-record.ts";
import { type Facts, render } from "../src/report.ts";

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: { green: true, line: "ok" },
  gateCount: 2,
  tickets: { "7": { state: "merged", title: "a" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const settings = (over: Partial<RunSettings> = {}): RunSettings => ({
  autonomy: 0,
  turn: 1,
  cap: 1,
  crossReview: false,
  usageGuard: false,
  ...over,
});

const settingsLine = (text: string) => text.split("\n").find((l) => l.startsWith("Settings:"));

test("the settings a record holds are named, and nothing else is said when nothing calls for a hint", () => {
  const out = render(facts({ settings: settings() }));
  assert.equal(settingsLine(out), "Settings: autonomy 0 (turn 1 of 1) · cross-review off · usage guard off");
  assert.doesNotMatch(out, /AUTONOMY_LEVEL|not guarded|was not guarded/);
});

test("cross-review's model and effort, the guard's threshold and a drain turn", () => {
  const out = render(facts({ settings: settings({ autonomy: "drain", turn: 3, cap: 20, crossReview: true, crossReviewModel: "gpt-5.1-codex", crossReviewEffort: "high", usageGuard: true, usageStop: 95 }) }));
  assert.equal(settingsLine(out), "Settings: autonomy drain (turn 3 of 20) · cross-review on (gpt-5.1-codex high) · usage guard on, stops at 95%");
});

test("autonomy 0 with tickets it could run again names AUTONOMY_LEVEL=2", () => {
  const out = render(facts({ settings: settings(), runnable: ["8"], tickets: { "7": { state: "merged" }, "8": { state: "blocked" }, "9": { state: "conflict" } } }));
  assert.match(out, /Autonomy 0 makes one turn, and #9 #8 could run again: `AUTONOMY_LEVEL=2` \(or `drain`\) lets one `sandcastle run` take them without starting it by hand\./);
});

test("no autonomy hint at a higher level, for a run that stopped, or with nothing to run again", () => {
  const left = { runnable: ["8"], tickets: { "7": { state: "merged" as const }, "8": { state: "blocked" as const } } };
  assert.doesNotMatch(render(facts({ ...left, settings: settings({ autonomy: 2, cap: 2 }) })), /AUTONOMY_LEVEL/);
  assert.doesNotMatch(render(facts({ ...left, stopped: "the base moved", settings: settings() })), /AUTONOMY_LEVEL/);
  assert.doesNotMatch(render(facts({ settings: settings() })), /AUTONOMY_LEVEL/);
});

test("a usage guard with no reading says the run was not guarded", () => {
  const out = render(facts({ settings: settings({ usageGuard: true, usageStop: 90, usageReading: "unavailable" }) }));
  assert.match(settingsLine(out)!, /usage guard on, stops at 90%, no reading$/);
  assert.match(out, /The usage guard had no reading, so this run was not guarded: check your usage yourself\./);
});

test("a guard with a reading, or no guard, gets no warning", () => {
  assert.doesNotMatch(render(facts({ settings: settings({ usageGuard: true, usageStop: 90 }) })), /not guarded/);
  assert.doesNotMatch(render(facts({ settings: settings({ usageGuard: false, usageReading: "unavailable" }) })), /not guarded/);
});

test("an old record with no settings, and a field the record lacks, say nothing", () => {
  assert.equal(settingsLine(render(facts())), undefined);
  assert.equal(settingsLine(render(facts({ settings: {} }))), undefined);
  assert.equal(settingsLine(render(facts({ settings: { autonomy: 1 } }))), "Settings: autonomy 1");
  assert.doesNotMatch(render(facts({ settings: { autonomy: 1 } })), /cross-review|usage guard/);
  // A value of the wrong type is unknown, not drawn.
  assert.equal(settingsLine(render(facts({ settings: { autonomy: "9" as never, crossReview: "yes" as never } }))), undefined);
});

test("the settings and a hint sit under the headline, before the next steps", () => {
  const out = render(facts({ settings: settings({ usageGuard: true, usageReading: "unavailable" }) }));
  assert.ok(out.indexOf("Settings:") < out.indexOf("## ✅ Done"));
  assert.ok(out.indexOf("not guarded") < out.indexOf("## ✅ Done"));
});
