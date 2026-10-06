// The closing summary says which tickets landed on a second attempt: the scheduler sent each back once
// after a conflict or a red gate at landing, and the second attempt merged. The run record keeps the
// fact in the ticket's `requeued` line, which stays on a merged ticket (and is null when the second
// attempt never began). Under Done; nothing is said when no ticket was sent back.
//
//   node --test test/report-second-attempt.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { render } = await import("../src/report.ts");
type Facts = Parameters<typeof render>[0];

const facts = (tickets: Facts["tickets"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 1,
  tickets,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  verify: { green: true, line: "test=pass" },
});

const section = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next);
};

const second = (out: string) => section(out, "## Done").filter((l) => l.startsWith("Landed on a second attempt"));

test("two tickets that landed on a second attempt after a conflict are named on one line under Done", () => {
  const line = "requeued after conflict with #1";
  const out = render(
    facts({
      "1": { state: "merged", title: "first" },
      "2": { state: "merged", title: "second", requeued: line, note: "merged and closed" },
      "3": { state: "merged", title: "third", requeued: line, note: "merged and closed" },
    }),
    true,
  );
  assert.deepEqual(second(out), ["Landed on a second attempt: #2, #3 (sent back after a conflict at landing)"]);
});

test("a ticket sent back after a red gate says so, apart from one sent back after a conflict", () => {
  const out = render(
    facts({
      "2": { state: "merged", requeued: "requeued after conflict with #1" },
      "3": { state: "merged", requeued: "requeued after red with #1 (gate test)" },
    }),
    true,
  );
  assert.deepEqual(second(out), ["Landed on a second attempt: #2 (sent back after a conflict at landing); #3 (sent back after a red gate at landing)"]);
});

test("a ticket whose second attempt never began (requeued null) and one never sent back are not named", () => {
  const out = render(facts({ "1": { state: "merged" }, "2": { state: "merged", requeued: null } }), true);
  assert.deepEqual(second(out), []);
});

test("a ticket sent back that did not land is not said to have landed on a second attempt", () => {
  const line = "requeued after conflict with #1";
  const out = render(facts({ "1": { state: "merged" }, "2": { state: "queued", requeued: line, note: line }, "3": { state: "conflict", requeued: line } }), true);
  assert.deepEqual(second(out), []);
});
