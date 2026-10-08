// A ticket the agent found nothing to change in is left open and queued (the kit never closes on an
// agent's word alone), so the closing summary must say so and name the step - not file it under
// Done with nothing to do, while every later run pays for it again.
//
//   pnpm test:file test/report-nochange.test.ts

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
  standing: [],
  keptWorktrees: [],
  changed: {},
});

const section = (text: string, heading: string) => text.split(heading)[1]?.split("\n## ")[0] ?? "";

test("a nothing-to-change ticket is said to stay open, with a next step", () => {
  const out = render(facts({ "43": { state: "nochange", title: "slugify" }, "42": { state: "merged", title: "reverse" } }), true);
  assert.match(section(out, "## Done"), /Nothing to change: #43 - left open, with the agent's evidence in a comment/);
  assert.match(section(out, "## Next step"), /Read the agent's comment on #43 \(nothing to change\): close it if the evidence holds.*every `sandcastle run` tries it again/);
});

test("without one, no such step", () => {
  const out = render(facts({ "42": { state: "merged", title: "reverse" } }), true);
  assert.doesNotMatch(out, /nothing to change/i);
});
