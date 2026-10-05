// The closing summary of a run whose base went red mid-run (the run record's `baseRed`): the
// base-red line is counted among those that need you, it never calls the tickets that failed on it
// held (they end gate-failed), and the first next step is fixing the base, before any ticket step.
//
//   pnpm exec tsx --test test/report-base-red-mid-run.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:41:00.000Z",
  finished: "2026-10-05T06:49:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 1,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

// The body of one section: the lines between its heading and the next.
const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

// One sandbox slot, one ticket: its gate failed on a test that fails on the base too.
const midRun = (over: Partial<Facts> = {}) =>
  render(facts({
    stage: "report",
    exitCode: 0,
    verify: null,
    tickets: { "79": { state: "red", started: 1, title: "clock tick", note: "test" } },
    standing: ["agent/issue-79"],
    baseRed: ["scripts/clock-check.mjs"],
    ...over,
  }));

test("a base that went red mid-run counts as one that needs you", () => {
  const out = midRun();
  assert.match(out, / - 1 attempted - 0 merged - 1 need you - 1 need fixing - /);
  // Two failing tests on the base are two lines, so two in the count.
  assert.match(midRun({ baseRed: ["scripts/clock-check.mjs", "test/a.test.ts"] }), / - 2 need you - /);
});

test("the base-red line says the tickets failed on it were not repaired, never held", () => {
  const line = body(midRun(), "## 🙋 Needs you").split("\n").find((l) => l.startsWith("- base went red mid-run"));
  assert.ok(line, "the base-red line is under Needs you");
  assert.match(line, /^- base went red mid-run: scripts\/clock-check\.mjs - /);
  assert.match(line, /not repaired/);
  assert.doesNotMatch(line, /held/);
});

test("the first next step is fixing the base, naming the test, before the ticket's step", () => {
  const next = body(midRun(), "## 👉 Next step").split("\n");
  assert.match(next[0], /^1\. Fix main first: scripts\/clock-check\.mjs fails on main itself/);
  const ticket = next.findIndex((l) => l.includes("#79"));
  assert.ok(ticket > 0, "the ticket's step comes after the base's");
});

test("a run with no base-red line keeps its counts and first step", () => {
  const out = midRun({ baseRed: undefined });
  assert.match(out, / - 0 need you - 1 need fixing - /);
  assert.match(body(out, "## 👉 Next step"), /^1\. Look at #79/m);
});
