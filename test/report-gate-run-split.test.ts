// The closing summary's causes tell a red gate run again from a gate run after a repair pass or a requeue, name the
// landings' share of the gates-slot wait, and print the files a ticket changed beyond its Touches line before the push
// note. Made-up timings lines and facts; no Docker, model or network.
//
//   pnpm test:file test/report-gate-run-split.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render, timeLostFromTimings } from "../src/report.ts";

const MIN = 60_000;

const line = (over: Record<string, unknown>) => JSON.stringify({ run: "r1", ms: 1000, ok: true, ...over });

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:00:00.000Z",
  finished: "2026-09-30T11:00:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const estimate = { ms: { mid: 60 * MIN, high: 90 * MIN }, tokensIn: { mid: 20_000_000, high: 30_000_000 }, tokensOut: { mid: 400_000, high: 600_000 }, slots: 2, tickets: 4 };
const tokenTotal = { input: 1_000_000, cacheWrite: 4_000_000, cacheRead: 85_000_000, output: 1_200_000 };
const causes = (out: string) => out.split("\n").filter((l) => l.startsWith("Largest causes"));

test("gate runs are counted apart: a red gate run again, a gate run after a repair pass, a gate run after a requeue", () => {
  const text = [
    line({ issue: "1", phase: "gates", ms: 3 * MIN }),
    line({ issue: "1", phase: "gates", ms: 4 * MIN, rerun: true }),
    line({ issue: "1", phase: "repair", ms: 6 * MIN }),
    line({ issue: "1", phase: "gates", ms: 2 * MIN }),
    line({ issue: "2", phase: "gates", ms: 5 * MIN }),
    line({ issue: "2", phase: "gates", ms: 7 * MIN }),
    line({ issue: "2", phase: "landing gates", ms: 1 * MIN, rerun: true }),
  ].join("\n");
  assert.deepEqual(timeLostFromTimings(text, "r1"), {
    gateWaitMs: 0, landingGateWaitMs: 0, landingWaitMs: 0,
    redReruns: 2, redRerunMs: 5 * MIN,
    afterRepair: 1, afterRepairMs: 2 * MIN,
    afterRequeue: 1, afterRequeueMs: 7 * MIN,
    repairs: 1, repairMs: 6 * MIN,
  });
});

test("the landing gates' share of the gates-slot wait is named apart and stays in the total", () => {
  const text = [
    line({ issue: "1", phase: "gates", ms: MIN, waitMs: 10 * MIN }),
    line({ issue: "1", phase: "landing gates", ms: MIN, waitMs: 30 * MIN }),
    line({ issue: "2", phase: "landing gates", ms: MIN, waitMs: 46 * MIN }),
  ].join("\n");
  const lost = timeLostFromTimings(text, "r1")!;
  assert.equal(lost.gateWaitMs, 86 * MIN);
  assert.equal(lost.landingGateWaitMs, 76 * MIN);
});

const base = { redReruns: 0, redRerunMs: 0, afterRepair: 0, afterRepairMs: 0, afterRequeue: 0, afterRequeueMs: 0, repairs: 0, repairMs: 0, landingWaitMs: 0, landingGateWaitMs: 0, gateWaitMs: 0 };

test("a slow run's causes line splits the gate runs and counts a requeued attempt's gates in the pass time", () => {
  const timeLost = { ...base, redReruns: 2, redRerunMs: 10 * MIN, afterRepair: 2, afterRepairMs: 8 * MIN, afterRequeue: 1, afterRequeueMs: 4 * MIN, repairs: 2, repairMs: 12 * MIN };
  const [l] = causes(render(facts({ estimate, tokenTotal, timeLost })));
  assert.equal(l, "Largest causes measured: 2 red gates run again, 2 gate runs after repair, 1 gate run after a requeue and 2 repair passes (34m of pass time).");
  const one = causes(render(facts({ estimate, tokenTotal, timeLost: { ...base, redReruns: 1, redRerunMs: 2 * MIN, repairs: 1, repairMs: 5 * MIN } })));
  assert.equal(one[0], "Largest causes measured: 1 red gate run again and 1 repair pass (7m of pass time).");
});

test("the landing share shows in the gates-slot wait only at a minute or more", () => {
  const within = { estimate: { ...estimate, ms: { mid: 180 * MIN, high: 240 * MIN } }, tokenTotal: { input: 1, cacheWrite: 0, cacheRead: 30_000_000, output: 600_000 } };
  const size = " `sandcastle size` says whether the machine has room for more gates slots.";
  const withShare = causes(render(facts({ ...within, timeLost: { ...base, gateWaitMs: 249 * MIN, landingGateWaitMs: 76 * MIN } })));
  assert.deepEqual(withShare, [`Largest causes measured: 4h 09m waiting for gates slots, summed over tickets (of which 1h 16m landings).${size}`]);
  const without = causes(render(facts({ ...within, timeLost: { ...base, gateWaitMs: 249 * MIN, landingGateWaitMs: 59_000 } })));
  assert.deepEqual(without, [`Largest causes measured: 4h 09m waiting for gates slots, summed over tickets.${size}`]);
});

const merged = (overrun?: string[]) =>
  facts({ tickets: { "1": { state: "merged", title: "t", ...(overrun ? { overrun } : {}) }, "2": { state: "merged", title: "u" } }, finished: "2026-09-30T06:30:00.000Z" });

test("files changed beyond a Touches line are listed under a lead-in directly before the push note", () => {
  const lines = render(merged(["src/other.ts", "docs/x.md"]), true).split("\n");
  const lead = lines.indexOf("Changed files beyond their Touches line:");
  const push = lines.findIndex((l) => l.startsWith("Closed on GitHub, but the code is only on your local main"));
  assert.ok(lead >= 0 && push >= 0, lines.join("\n"));
  assert.equal(lines[lead + 1], "  #1 t: src/other.ts, +1 docs file");
  assert.equal(push, lead + 2);
});

test("a run with no overrun has no lead-in", () => {
  assert.ok(!render(merged(), true).includes("beyond their Touches"));
  assert.ok(!render(merged(["test/a.test.ts", "README.md"]), true).includes("beyond their Touches"));
});
