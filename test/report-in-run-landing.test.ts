// With in-run landing a ticket can be red only once merged (green on its own branch, red with a
// ticket that landed meanwhile) or put back in the queue. The closing summary names the pair and
// says so; the headline still counts what landed during the run, and the verify line is unchanged.
//
//   node --test test/report-in-run-landing.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

const facts = (tickets: Facts["tickets"], over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: { green: true, line: "ruff=pass pytest=pass" },
  gateCount: 2,
  tickets,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const section = (text: string, heading: string) => text.split(heading)[1]?.split("\n## ")[0] ?? "";

// Red together is told from a red gate by the outcome's kind (outcomes.json), never by the note's words.
const mixed = (over: Partial<Facts> = {}) =>
  facts(
    {
      "11": { state: "merged", title: "a", started: 1 },
      "12": { state: "merged", title: "b", started: 1 },
      "13": { state: "red", title: "c", started: 1, note: "red with #11, #12", failing: ["tests/test_a.py::test_x"] },
      "14": { state: "red", title: "d", started: 1, note: "pytest red, 1 repair(s)" },
      "15": { state: "queued", title: "e", started: 1, note: "requeued after red with #12", requeued: "requeued after red with #12" },
    },
    { outcomes: { "11": "merged", "12": "merged", "13": "red", "14": "gate red" }, ...over },
  );

test("a ticket red at landing is listed as red together with its pair, not as a failed gate", () => {
  const out = render(mixed(), true);
  const fixing = section(out, "## Needs fixing");
  assert.match(fixing, /- #13 c - red together with #11, #12 \(green on its own branch\) - failing: tests\/test_a\.py::test_x \(branch agent\/issue-13\)/);
  assert.doesNotMatch(fixing, /gate red with/);
  // A red gate in its own pipeline keeps its wording.
  assert.match(fixing, /- #14 d - gate pytest red, 1 repair\(s\)/);
});

test("red on the merged tree with no pair named still reads red together", () => {
  const out = render(facts({ "13": { state: "red", title: "c", note: "red on the merged tree" } }, { outcomes: { "13": "red" } }), true);
  assert.match(section(out, "## Needs fixing"), /- #13 c - red together on the merged tree/);
});

test("a requeued ticket says so, is not cut short, and gets a next step", () => {
  const out = render(mixed(), true);
  assert.match(section(out, "## Runnable now"), /Requeued: #15 e - requeued after red with #12 - still queued for the next run/);
  assert.match(section(out, "## Next step"), /`sandcastle run` again for #15: requeued during this run\./);
  // Not a ticket the run left half-done, and not one a person must fix.
  assert.doesNotMatch(section(out, "## Needs fixing"), /#15/);
  const early = render(mixed({ finished: "2026-09-30T07:00:00.000Z", exitCode: 1, stage: "running" }), true);
  assert.doesNotMatch(early, /Cut short when the run ended: .*#15/);
});

test("a blocker red together reads so in the blocked section", () => {
  const out = render(mixed({ blocked: [{ id: "16", on: ["#13"] }] }), true);
  assert.match(section(out, "## Runnable now"), /#16 waits for #13 \(red together\)/);
});

test("the headline counts the tickets that landed during the run; the verify line keeps its meaning", () => {
  const out = render(mixed(), true);
  assert.match(out, /5 attempted - 2 merged - 0 need you - 2 need fixing - 0 not started/);
  assert.match(out, /Merged main re-gated: all 2 gates green\./);
  const red = render(mixed({ verify: { green: false, line: "pytest=fail" } }), true);
  assert.match(red, /Merged main re-gated: RED TOGETHER \(pytest=fail\)/);
  // A live run: partial, with what has landed so far.
  const live = render(mixed({ live: true, finished: undefined, verify: undefined }), true);
  assert.match(live, /still running - partial summary/);
  assert.match(live, /2 merged/);
});
