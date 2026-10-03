// A held branch's unmet acceptance criterion is on its Needs-you line, so whoever lands it by hand
// (`sandcastle land` merges it as partly done) sees it before they do.
//
//   pnpm exec tsx --test test/report-held-unmet.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

const facts = (tickets: Facts["tickets"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:45:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets,
  runnable: [],
  blocked: [],
  standing: ["agent/issue-206"],
  keptWorktrees: [],
  changed: { "206": 2, "207": 1 },
});

const section = (text: string, heading: string) => text.split(heading)[1]?.split("\n## ")[0] ?? "";

test("a held branch's criterion is on its Needs-you line", () => {
  const out = render(facts({ "206": { state: "held", title: "pre-push check", files: [".githooks/pre-push"], unmet: "the hook is not installed" } }), true);
  const needs = section(out, "## Needs you");
  assert.match(needs, /#206 pre-push check - changes \.githooks\/pre-push - 2 file\(s\) - criterion unmet: the hook is not installed/);
  assert.match(needs, /review: git log -p main\.\.agent\/issue-206/);
});

test("a held branch without one has the line it always had", () => {
  const out = render(facts({ "207": { state: "held", title: "other", files: ["ci.yml"] } }), true);
  const needs = section(out, "## Needs you");
  assert.match(needs, /- #207 other - changes ci\.yml - 1 file\(s\)\n/);
  assert.doesNotMatch(needs, /criterion/);
});

test("a criterion cut at the cap says where the rest is", () => {
  const out = render(facts({ "206": { state: "held", title: "t", note: "held", unmet: "something long…" } }), true);
  assert.match(section(out, "## Needs you"), /criterion unmet: something long… \(cut short - full text in the agents' logs, \.sandcastle\/logs\/agent-issue-206-\*\.log\)/);
});
