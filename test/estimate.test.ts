// The estimate a run prints before its slow steps (src/run.ts `estimate`):
// the median-to-80th-percentile range of this project's earlier tickets in timings.jsonl, noise ignored,
// and nothing at all without history.
//
//   pnpm exec tsx --test test/estimate.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const tok = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({ input, cacheWrite, cacheRead, output });
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

const project = (lines: string[] | undefined) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-"));
  if (lines) {
    mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  }
  return { root, name: "fixture" } as Project;
};

const noise = [
  line({ issue: "0", phase: "base-gates", ms: 999_999 }),
  JSON.stringify({ project: "other", run: "r1", issue: "1", phase: "implement", ms: 9_999_999, tokens: tok(0, 0, 90_000_000, 900_000) }),
  "not json",
  line({ issue: "4", phase: "gates", ms: 9_000_000 }),
];

const history = [
  line({ issue: "1", phase: "implement", ms: 300_000, tokens: tok(0, 0, 1_000_000, 10_000) }),
  line({ issue: "1", phase: "gates", ms: 300_000 }),
  line({ issue: "2", phase: "implement", ms: 600_000, tokens: tok(500_000, 500_000, 0, 5_000) }),
  line({ issue: "2", phase: "review", ms: 600_000, tokens: tok(0, 0, 1_000_000, 15_000) }),
  line({ issue: "3", phase: "implement", ms: 1_800_000, tokens: tok(3_000_000, 0, 0, 30_000) }),
  ...noise,
];

test("medians of earlier tickets, times the tickets, time across the slots", () => {
  const p = project(history);
  assert.equal(
    estimate(p, 5, 2),
    "Estimate (rough, from 3 ticket(s) in the last 3 runs): about 10.0M to 15.0M tokens in / 100k to 150k out and 1h 00m to 1h 30m for 5 ticket(s), 2 at a time.",
  );
  assert.match(estimate(p, 1, 4)!, /about 2\.0M to 3\.0M tokens in \/ 20k to 30k out and 20m to 30m for 1 ticket\(s\), 4 at a time\.$/);
});

test("no timings file: nothing to print", () => {
  assert.equal(estimate(project(undefined), 3, 1), undefined);
});

test("only noise (other project, base gates, bad lines, no tokens): nothing to print", () => {
  assert.equal(estimate(project(noise), 3, 1), undefined);
});
