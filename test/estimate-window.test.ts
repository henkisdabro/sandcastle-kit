// The estimate and the status view's typical times read the tickets of the
// project's last three runs only (src/run.ts `recentWindow`), widened to older
// runs while those hold fewer than 5 tickets; lines without a `run` are oldest.
//
//   pnpm exec tsx --test test/estimate-window.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate, typicalTimes } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tok = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output });

/** One ticket: an implement step (with tokens) and a gates step. Run 0 means no `run` field. */
const ticket = (run: string | undefined, issue: number, minutes: number, input: number, output: number) =>
  [
    { project: "fixture", ...(run ? { run } : {}), issue: String(issue), phase: "implement", ms: minutes * MIN, tokens: tok(input, output) },
    { project: "fixture", ...(run ? { run } : {}), issue: String(issue), phase: "gates", ms: minutes * MIN },
  ].map((l) => JSON.stringify(l));

const runAt = (n: number) => `2026-09-${String(n).padStart(2, "0")}T10:00:00.000Z`;

/** `count` tickets in the run, numbered from `first`. */
const batch = (run: string | undefined, first: number, count: number, minutes: number, input: number, output: number) =>
  Array.from({ length: count }, (_, i) => ticket(run, first + i, minutes, input, output)).flat();

const project = (lines: string[] | undefined) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-window-"));
  if (lines) {
    mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  }
  return { root, name: "fixture" } as Project;
};

test("many small tickets in four old runs, a few large ones in the last three: the large ones only", () => {
  const p = project([
    // Written newest-last on purpose: the window goes by the `run` field, not the file order.
    ...[1, 2, 3, 4].flatMap((n) => batch(runAt(n), n * 10, 4, 1, 100_000, 1_000)),
    ...[5, 6, 7].flatMap((n) => batch(runAt(n), n * 10, 2, 10, 2_000_000, 20_000)),
  ]);
  // 6 tickets in the last three runs, all large: medians of those, not of the 22 tickets.
  assert.equal(
    estimate(p, 4, 2),
    "Estimate (rough, from 6 ticket(s) in the last 3 runs): about 8.0M tokens in / 80k out and 40m for 4 ticket(s), 2 at a time.",
  );
  // Each ticket is 10m implement + 10m gates.
  assert.deepEqual(typicalTimes(p), { implement: 600, gates: 600, issue: 1200 });
});

test("fewer than 5 tickets in the last three runs widens to older runs, newest first", () => {
  const p = project([
    ...batch(runAt(1), 10, 3, 1, 100_000, 1_000),
    ...batch(runAt(2), 20, 3, 1, 100_000, 1_000),
    ...batch(runAt(5), 50, 1, 10, 2_000_000, 20_000),
    ...batch(runAt(6), 60, 1, 10, 2_000_000, 20_000),
    ...batch(runAt(7), 70, 1, 10, 2_000_000, 20_000),
  ]);
  // Three tickets in the last three runs; run 2 adds three more (6, enough), run 1 stays out.
  assert.match(estimate(p, 1, 1)!, /^Estimate \(rough, from 6 ticket\(s\) in the last 3 runs\)/);
  // Median of 3 large + 3 small tickets: the upper middle of the sorted values.
  assert.deepEqual(typicalTimes(p), { implement: 600, gates: 600, issue: 1200 });
});

test("a run with only base-gate lines is not one of the three", () => {
  const p = project([
    ...batch(runAt(1), 10, 5, 1, 100_000, 1_000),
    ...[5, 6, 7].flatMap((n) => batch(runAt(n), n * 10, 2, 10, 2_000_000, 20_000)),
    JSON.stringify({ project: "fixture", run: runAt(9), issue: "0", phase: "base-gates", ms: 5 * MIN }),
  ]);
  assert.match(estimate(p, 1, 1)!, /^Estimate \(rough, from 6 ticket\(s\)/);
  assert.equal(typicalTimes(p).issue, 1200);
});

test("lines without a run count as one run older than every run that has one", () => {
  const p = project([
    ...batch(undefined, 10, 4, 1, 100_000, 1_000),
    ...batch(runAt(1), 20, 1, 10, 2_000_000, 20_000),
    ...batch(runAt(2), 30, 1, 10, 2_000_000, 20_000),
    ...batch(runAt(3), 40, 1, 10, 2_000_000, 20_000),
  ]);
  // The three dated runs hold 3 tickets, so the undated lines (4 more) are taken as the fourth run.
  assert.match(estimate(p, 1, 1)!, /^Estimate \(rough, from 7 ticket\(s\)/);
  // With enough dated tickets they are left out.
  const q = project([
    ...batch(undefined, 10, 4, 1, 100_000, 1_000),
    ...[1, 2, 3].flatMap((n) => batch(runAt(n), n * 10, 2, 10, 2_000_000, 20_000)),
  ]);
  assert.match(estimate(q, 1, 1)!, /^Estimate \(rough, from 6 ticket\(s\)/);
  assert.equal(typicalTimes(q).issue, 1200);
});

test("an empty or missing file still gives undefined and {}", () => {
  assert.equal(estimate(project(undefined), 3, 1), undefined);
  assert.deepEqual(typicalTimes(project(undefined)), {});
  assert.equal(estimate(project([]), 3, 1), undefined);
  assert.deepEqual(typicalTimes(project([])), {});
});
