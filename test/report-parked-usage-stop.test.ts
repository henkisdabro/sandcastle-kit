// A stop of any cause wakes the tickets a pause parked, and each ends with its record still `paused`.
// A usage stop sets no `stopped` and exits 0, so the summary that read a parked ticket as runnable only
// after a guard's stop or an early end listed it nowhere - counted as attempted, in no section. A run
// that is not live is not paused: a ticket still parked when it ended is runnable. Only `render`. No
// Docker, no git, no network.
//
//   node --test test/report-parked-usage-stop.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;

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
    "59": { state: "skipped", title: "median", note: "not started: usage at 95%" },
  },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  ...over,
});
const section = (out: string, heading: string) => out.split(`## ${heading}`)[1]?.split("\n## ")[0] ?? "";

test("a run a usage stop ended while paused lists its parked ticket under Runnable now, and the next step picks it up", () => {
  const out = render(facts({}), true);
  assert.match(section(out, "Runnable now / Still blocked"), /Runnable now: #57 \(paused before review at a1b2c3d - its branch resumes\)/);
  assert.match(section(out, "Next step"), /picks up #57 where this run ended/);
});

test("a live paused run's parked ticket is still in flight, not runnable", () => {
  const out = render(facts({ live: true, finished: undefined, paused: { since: 1_790_000_000 } }), true);
  assert.doesNotMatch(section(out, "Runnable now / Still blocked"), /Runnable now: #57/);
});
