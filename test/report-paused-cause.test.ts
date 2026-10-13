// A slow run's closing summary names the time it spent paused among the causes of the overrun. Made-up facts; no
// Docker, model or network.
//
//   pnpm test:file test/report-paused-cause.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render } from "../src/report.ts";

const MIN = 60_000;

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
  estimate: { ms: { mid: 60 * MIN, high: 90 * MIN }, tokensIn: { mid: 20_000_000, high: 30_000_000 }, tokensOut: { mid: 400_000, high: 600_000 }, slots: 2, tickets: 4 },
  ...over,
});

const headline = (out: string) => out.split("\n").filter((l) => /^(Largest causes|No cause measured)/.test(l));

test("a pause larger than every other cause leads the causes", () => {
  const out = render(facts({ pausedMs: 180 * MIN, sharedMs: 20 * MIN, sandboxWaitMs: 10 * MIN }));
  assert.deepEqual(headline(out), [
    "Largest causes measured: 3h 00m paused (sandcastle pause or the plan's usage); 20m at a share below what it asked for, beside another run; 10m with a worker waiting for a sandbox slot.",
  ]);
});

test("a pause under a minute is left out like the other causes", () => {
  const out = render(facts({ pausedMs: 30_000 }));
  assert.match(headline(out)[0], /^No cause measured: no pause, /);
});
