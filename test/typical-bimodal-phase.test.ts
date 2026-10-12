// `typicalTimes` is what the status view's TIME turns red at twice of, and says "3x over, usually ..." at three
// times. A phase with two kinds of run (gates on a warm build cache, gates on a cold one) is judged against its
// slow kind, so a cold run is not flagged as stuck.
//
//   pnpm test:file test/typical-bimodal-phase.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { typicalTimes } = await import("../src/run.ts");
type Project = Parameters<typeof typicalTimes>[0];

const SEC = 1000;

/** One run of tickets whose gates took the given seconds, one ticket each. */
const project = (gateSeconds: number[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-bimodal-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = gateSeconds.flatMap((s, i) => [
    { project: "fixture", run: "2026-09-01T10:00:00.000Z", issue: String(i + 1), phase: "implement", ms: 300 * SEC },
    { project: "fixture", run: "2026-09-01T10:00:00.000Z", issue: String(i + 1), phase: "gates", ms: s * SEC },
  ]);
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

test("a gates history of warm runs under a minute and cold runs of three minutes is usually the cold time", () => {
  // 10 warm (40 s) and 8 cold (200 s): the median is a warm run, so a cold run showed "3x over" at 120 s.
  const gates = typicalTimes(project([...Array(10).fill(40), ...Array(8).fill(200)])).gates;
  assert.equal(gates, 200);
  // A cold run is nowhere near three times that, at its slowest (225 s) either.
  assert.ok(225 < 3 * gates);
});

test("a phase whose runs all take the same time is usually that time", () => {
  assert.equal(typicalTimes(project(Array(7).fill(600))).gates, 600);
});

test("one finished run is its own usual time", () => {
  assert.equal(typicalTimes(project([90])).gates, 90);
});
