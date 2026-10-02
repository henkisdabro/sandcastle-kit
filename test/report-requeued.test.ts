// A ticket sent back once after a conflict or a red at landing is recorded as "queued" with the
// fact in a separate `requeued` field (null once the second attempt is not going to run).
// The report reads the field: "requeued" is not a ticket state.
//
//   pnpm exec tsx --test test/report-requeued.test.ts

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

test("a queued ticket with a requeued line is listed, with the next step", () => {
  const line = "requeued after conflict with #42";
  const out = render(facts({ "43": { state: "queued", title: "slugify", note: line, requeued: line }, "42": { state: "merged", title: "reverse" } }), true);
  assert.match(section(out, "## Runnable now / Still blocked"), /Requeued: #43 slugify - requeued after conflict with #42 - still queued for the next run/);
  assert.match(section(out, "## Next step"), /`sandcastle run` again for #43: requeued during this run/);
});

test("a queued ticket whose requeued is null is not listed as requeued", () => {
  const out = render(facts({ "43": { state: "queued", title: "slugify", requeued: null }, "42": { state: "merged", title: "reverse" } }), true);
  assert.doesNotMatch(out, /Requeued:/);
  assert.doesNotMatch(out, /requeued during this run/);
});

test("a requeued ticket is not also reported as not started when the run ended early", () => {
  const line = "requeued after red with #42";
  const out = render({ ...facts({ "43": { state: "queued", requeued: line, note: line } }), killed: true }, true);
  assert.equal(out.match(/#43/g)?.filter(Boolean).length, out.match(/#43/g)?.length);
  assert.doesNotMatch(out, /Not started \(the run ended early\)/);
});
