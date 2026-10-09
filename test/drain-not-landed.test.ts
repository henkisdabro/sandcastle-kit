// A green branch whose landing did not happen (a sandbox that would not open, a branch that moved) is
// re-run by the drain: the summary already tells the operator the next run lands it, and a drain that
// stopped on "no ticket is left to run again" contradicted that. The same ticket failing to land in two
// turns running stops the drain, as a repeated conflict does.
//
//   pnpm test:file test/drain-not-landed.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { drainStop, nextTurn, rerunList, rerunnable } = await import("../src/autonomy.ts");
const { refOf } = await import("../src/tracker.ts");
type Facts = Parameters<typeof rerunnable>[0];

const facts = {
  base: "main",
  tracker: "github",
  started: "2026-01-01T00:00:00Z",
  live: false,
  dryRun: false,
  verify: { green: true, line: "" },
  gateCount: 1,
  tickets: { 1: { state: "merged" }, 2: { state: "not landed", note: "could not land it in a sandbox: fatal: cannot lock ref" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
} as unknown as Facts;

test("a not-landed ticket is re-runnable, and the drain takes another turn for it", () => {
  const again = rerunnable(facts)!;
  assert.deepEqual(again.unlanded, ["2"]);
  assert.equal(nextTurn("drain", 1, again), "run");
  assert.match(rerunList(again, refOf), /not landed: #2/);
});

test("the same ticket failing to land in two turns running stops the drain", () => {
  const turn = { landed: 1, released: [], conflicted: [], unlanded: ["2"] };
  assert.equal(drainStop(turn, undefined, refOf), undefined);
  assert.equal(drainStop(turn, turn, refOf), "#2 failed to land in two turns running");
});
