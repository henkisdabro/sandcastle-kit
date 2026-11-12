// The typical landing gates are the median over the landings that ran gates, and a window of fast-forwards has none, so
// the status view's floor on the run's end ("tickets not yet landed, less one, times it") is not "n times 0". Made-up
// timings and run records; no Docker, model or network.
//
//   pnpm test:file test/landing-gates-floor.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { typicalTimes } = await import("../src/run.ts");
const { runEnds } = await import("../src/status-snapshot.ts");
type Project = Parameters<typeof typicalTimes>[0];

const MIN = 60_000;

const fastForwards = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-landing-floor-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = ["1", "2", "3"].flatMap((issue) => [
    { issue, phase: "implement", ms: MIN },
    { issue, phase: "landing", ms: 1000, ok: true, result: "merged" },
  ].map((l) => JSON.stringify({ project: "fixture", run: "r1", ...l })));
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

test("a window of fast-forward landings has no typical landing gates, not 0", () => {
  assert.equal("landing gates" in typicalTimes(fastForwards()), false);
  assert.equal("landing gates" in typicalTimes(fastForwards(), [], 1), false);
});

test("the run's end waits for the landings after the first: the next one may be a fast-forward", () => {
  const now = 1_800_000_000;
  const record = { stage: "running", concurrency: 1, typical: { issue: 600, "landing gates": 300 } } as Parameters<typeof runEnds>[0];
  const landing = { state: "landing", since: now } as never;
  assert.equal(runEnds(record, { "1": landing, "2": landing }, now), now + 300);
  assert.equal(runEnds(record, { "1": landing }, now), now);
});
