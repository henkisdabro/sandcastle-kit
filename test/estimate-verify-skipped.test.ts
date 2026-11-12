// A run that skipped its verify writes no `verify` line (a skipped base gates pass writes a 0 ms one), so the estimate
// counts it as 0: one value per window run that has a `base gates` line, the run's lines of the phase summed. Made-up
// timings; no Docker, model or network.
//
//   pnpm test:file test/estimate-verify-skipped.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { priceRun } = await import("../src/run.ts");
type Project = NonNullable<Parameters<typeof priceRun>[0]>;

const MIN = 60_000;
const tokens = { input: 0, cacheWrite: 0, cacheRead: 100_000, output: 1_000 };

/** Three runs, oldest first, each with one 10m ticket and a 0 ms `base gates` line; `verifies` are the minutes of each run's `verify` lines. */
const project = (verifies: number[][], baseGates: boolean[] = [true, true, true]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-verify-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = verifies.flatMap((vs, i) => {
    const line = (o: object) => JSON.stringify({ project: "fixture", run: `2026-01-0${i + 1}T00:00:00.000Z`, ...o });
    return [
      line({ issue: "1", phase: "implement", ms: 10 * MIN, tokens }),
      ...(baseGates[i] ? [line({ issue: "0", phase: "base gates", ms: 0 })] : []),
      ...vs.map((v) => line({ issue: "0", phase: "verify", ms: v * MIN })),
    ];
  });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

const mid = (p: Project) => priceRun(p, 1, 2)!.figures.ms.mid;

test("a run that skipped its verify counts 0, so one verify in the oldest of three runs adds nothing", () => {
  assert.equal(mid(project([[25], [], []])), mid(project([[], [], []])));
});

test("two verify lines of one run are summed before the median over runs", () => {
  // Per-run sums [8, 0, 0]: the median is 0, where the median of the lines [4, 4] was 4m.
  assert.equal(mid(project([[4, 4], [], []])), mid(project([[], [], []])));
  // Per-run sums [8, 8, 0]: the median is 8m.
  assert.equal(mid(project([[4, 4], [8], []])), mid(project([[], [], []])) + 8 * MIN);
});

test("a run with no base gates line is left out of both stages", () => {
  // The oldest run's 25m verify has no base gates line beside it: it is an older run's, not a skipped one's.
  assert.equal(mid(project([[25], [], []], [false, true, true])), mid(project([[], [], []])));
});
