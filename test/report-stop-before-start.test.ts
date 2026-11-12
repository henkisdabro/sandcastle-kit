// A run that never started a ticket and was not red: stopped by a person while its base gates waited for a
// slot, or refused by its preflight. Neither is "red on main", and the preflight's headline says what it was.
//
//   pnpm test:file test/report-stop-before-start.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";
import type { TicketRecord } from "../mod/hooks/run-record.ts";

const queued: Record<string, TicketRecord> = Object.fromEntries(["1", "2"].map((id, order) => [id, { state: "queued", order, title: `t${id}` }]));

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:49:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: queued,
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  exitCode: 1,
  ...over,
});

test("a stop while the base gates waited is a stop, not a red base", () => {
  const out = render(facts({ stage: "base gates", stoppedBy: "sandcastle stop" }));
  assert.doesNotMatch(out, /red on main|Base gates: red|base-gates\.log/);
  assert.match(out, /^## 🏁 Run stopped by `sandcastle stop` - partial summary/m);
});

test("a preflight refusal says no sandbox started and gives no estimate line", () => {
  const out = render(facts({ stage: "preflight", estimate: { ms: { mid: 6_000_000, high: 9_000_000 }, tokensIn: { mid: 1, high: 1 }, tokensOut: { mid: 1, high: 1 }, slots: 1, tickets: 2 } }));
  assert.match(out, /NOT STARTED: preflight failed \(exit 1\) - no sandbox started/);
  assert.doesNotMatch(out, /Against the estimate|Run ended early/);
});
