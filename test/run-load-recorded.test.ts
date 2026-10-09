// A finished run records the ticket slots it could use averaged over its time (time-weighted, rounded, a half
// rounds up), not the share it started with: the estimate prices later runs from `load.concurrency`.
// Made-up clock and project; no Docker, model or network.
//
//   pnpm test:file test/run-load-recorded.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLoadMeter, recordRun } = await import("../src/run.ts");
type Project = Parameters<typeof recordRun>[0];

/** A run recorded at `start` slots, whose share moves as `moves` say (hours since the start, slots), over `hours`; its history line. */
const finished = (start: number, moves: [number, number][], hours: number) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-load-recorded-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  let clock = 0;
  const load = createLoadMeter(start, () => clock * 3_600_000);
  const run = recordRun({ root, name: "fixture" } as Project, { concurrency: start, load: { concurrency: start, tickets: 6 } });
  run.finishWith(() => {
    const concurrency = load.mean();
    return { concurrency, load: { concurrency, tickets: 6 } };
  });
  for (const [at, slots] of moves) {
    clock = at;
    load.sample(slots);
  }
  clock = hours;
  // A new record finishes the one before it, as the next turn's would.
  recordRun({ root, name: "fixture" } as Project).finishWith(() => ({}));
  const line = readFileSync(join(root, ".sandcastle/logs/history.jsonl"), "utf8").split("\n").filter(Boolean)[0];
  return JSON.parse(line) as { concurrency: number; load: { concurrency: number; tickets: number } };
};

test("a run whose share went from 1 to 2 halfway records 2", () => {
  const h = finished(1, [[2, 2]], 4);
  assert.equal(h.load.concurrency, 2);
  assert.equal(h.concurrency, 2);
  assert.equal(h.load.tickets, 6);
});

test("a run whose share was 1 for most of its time records 1", () => {
  assert.equal(finished(1, [[3, 2]], 4).load.concurrency, 1);
});

test("a run whose share fell from 3 to 1 records the time-weighted mean, a half rounded up", () => {
  // (3 x 3h + 1 x 1h) / 4h = 2.5, a half rounds up
  assert.equal(finished(3, [[3, 1]], 4).load.concurrency, 3);
  // (3 x 2h + 1 x 2h) / 4h = 2
  assert.equal(finished(3, [[2, 1]], 4).load.concurrency, 2);
});

test("a run whose share never moved records the start's", () => {
  assert.equal(finished(2, [], 4).load.concurrency, 2);
});

test("a run that ends the instant it starts records the start's", () => {
  assert.equal(finished(2, [], 0).load.concurrency, 2);
});

test("burndown() feeds the meter from the share samples and records its mean at the end", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /const load = createLoadMeter\(slots\);\s+run\.finishWith\(/);
  assert.match(src, /load\.sample\(estimateSlots\(workers, otherRuns\(\)\.length/);
});
