// A run cut short (Ctrl-C, a crash, kill -9) left tickets mid-work: the summary counted them as
// attempted, then listed them in no section, and its headline said "finished". It must say the run
// ended early, name each ticket it cut short or never started, and say that the next run picks
// them up - they keep their queue label and the next run resumes their branches.
//
//   pnpm exec tsx --test test/report-interrupted.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

const facts = (over: Partial<Facts>): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:45:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: {
    "57": { state: "implement", title: "wordWrap", started: 1 },
    "58": { state: "queued", title: "median" },
    "59": { state: "merged", title: "mean", started: 1 },
  },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "running",
  exitCode: 1,
  ...over,
});

const section = (text: string, heading: string) => text.split(heading)[1]?.split("\n## ")[0] ?? "";

test("an interrupted run says so and names what it cut short", () => {
  const out = render(facts({}), true);
  assert.match(out, /^## Run ended early \(exit 1\) - partial summary/);
  assert.match(out, / - 2 attempted - 1 merged - .* - 1 not started/);
  assert.match(out, /not re-gated \(the run ended before it got there\)/);
  const left = section(out, "## Runnable now / Still blocked");
  assert.match(left, /Cut short when the run ended: #57 \(implement\) - still queued/);
  assert.match(left, /Not started \(the run ended early\): #58/);
  assert.match(section(out, "## Next step"), /`sandcastle run` again: it picks up #57 #58/);
});

test("a killed run lists them the same way", () => {
  const out = render(facts({ finished: undefined, killed: true, exitCode: undefined }), true);
  assert.match(out, /^## Run ended without a clean exit \(killed\?\) - partial summary/);
  assert.match(section(out, "## Runnable now / Still blocked"), /Cut short when the run ended: #57 \(implement\)/);
  assert.match(section(out, "## Next step"), /stops any sandbox the killed run left working/);
});

test("a run that finished cleanly lists nothing as cut short", () => {
  const out = render(facts({ stage: "report", exitCode: 0, tickets: { "59": { state: "merged", title: "mean", started: 1 } } }), true);
  assert.match(out, /^## Run finished/);
  assert.doesNotMatch(out, /cut short|ended early/i);
});
