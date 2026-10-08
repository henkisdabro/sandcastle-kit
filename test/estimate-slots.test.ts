// The run estimate prices the tickets as their summed figures over the slots, floored at the slowest single
// ticket (src/run.ts `estimate`): a sixth ticket on five slots starts when the first slot frees, so it is not a
// whole extra round, and no run is shorter than its longest ticket.
//
//   pnpm test:file test/estimate-slots.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate } = await import("../src/run.ts");
const { IMPL_MODEL } = await import("../src/agents.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const OPUS = "claude-opus-fixture";
const tokens = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };
const line = (issue: string, ms: number, model: string) => JSON.stringify({ project: "fixture", run: "r1", issue, phase: "implement", ms, model, tokens });

/** Five 10m tickets on the default model and five 27m Opus tickets: each model's own history is solid. */
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-slots-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = ["1", "2", "3", "4", "5"].map((i) => line(i, 10 * MIN, IMPL_MODEL)).concat(["6", "7", "8", "9", "10"].map((i) => line(i, 27 * MIN, OPUS)));
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

/** The minutes of an estimate's time figure ("12m"), both ends of a range alike. */
const minutes = (text: string | undefined): number[] =>
  [...text!.match(/ and (.*?) for \d+ ticket/)![1].matchAll(/(?:(\d+)h )?(\d+)m/g)].map((m) => Number(m[1] ?? 0) * 60 + Number(m[2]));

const sonnet = (n: number) => Array.from({ length: n }, () => IMPL_MODEL);

test("6 equal tickets on 5 slots read about 1.2 times 5 on 5, not twice", () => {
  const p = project();
  const [five] = minutes(estimate(p, 5, 5, 0, sonnet(5)));
  const [six] = minutes(estimate(p, 6, 5, 0, sonnet(6)));
  assert.equal(five, 10);
  assert.equal(six, 12);
});

test("a run that includes a long Opus ticket is never under that ticket's own figure", () => {
  const p = project();
  const models = [OPUS, ...sonnet(4)];
  // Median and high end are both the Opus ticket's 27m, so the range is one figure.
  assert.deepEqual(minutes(estimate(p, 5, 5, 0, models)), [27]);
  // More slots than tickets cannot go below it either.
  assert.deepEqual(minutes(estimate(p, 5, 50, 0, models)), [27]);
  // A narrow pool is the summed figures over the slots: 27m + 4 x 10m = 67m over 2 slots (33.5m, above the floor).
  assert.deepEqual(minutes(estimate(p, 5, 2, 0, models)), [34]);
});

test("the chain, gate and landing bounds still win when they are the largest", () => {
  const p = project();
  assert.deepEqual(minutes(estimate(p, 6, 5, 3, sonnet(6))), [30]);
});
