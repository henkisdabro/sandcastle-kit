// `sandcastle size` and the pool warning price a figure at the 90th percentile of the recent samples, not their
// maximum: one agent pass far above the rest must not set every later pool. Expected figures are worked by hand:
// a MiB figure x 1.1, rounded up, over 1024. Fake readers, no Docker, model call or network.
//
//   pnpm test:file test/size-percentile.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.HOME = process.env.XDG_CONFIG_HOME;
const { measuredPeak, poolWarnings, recommend, sizeLines } = await import("../src/size.ts");

const GIB = 2 ** 30;
const NOW = Date.parse("2026-05-10T00:00:00Z");
type Line = Parameters<typeof measuredPeak>[0][number];

// One agent sandbox's line: 2560 MiB of anonymous memory in a gate, `agent` MiB in an agent pass.
const sandbox = (agent: number, i: number): Line => ({ ts: "2026-05-09T00:00:00.000Z", project: "abc123", run: `r${i % 3}`, peakMib: 4000, anonMib: 2560, agentMib: 3000, agentAnonMib: agent, sampled: 2 });
const samples = (n: number, outlier?: number) => Array.from({ length: n }, (_, i) => sandbox(outlier !== undefined && i === 0 ? outlier : 2560, i));

const reading = (peaks: Line[]) => ({
  dockerInfo: () => JSON.stringify({ NCPU: 12, MemTotal: 14 * GIB, OperatingSystem: "OrbStack", Name: "orbstack" }),
  hostMemory: () => 64 * GIB,
  hostCpus: () => 16,
  freeDisk: () => 100 * GIB,
  exists: () => false,
  home: () => "/home/user",
  platform: "darwin" as const,
  peaks: () => peaks,
  now: () => NOW,
});

test("one outlier among 34 agent samples does not price the agent baseline, and size names the highest", () => {
  const peaks = samples(34, 5222);
  const m = measuredPeak(peaks, NOW)!;
  assert.equal(m.agentAnonMib, 2560);
  assert.deepEqual(m.figures.agentAnon, { mib: 2560, samples: 34, highest: 5222 });
  // 2560 x 1.1 = 2816 MiB = 2.75 GiB, not 5222 x 1.1 = 5745 MiB = 5.61 GiB.
  assert.equal(recommend(14 * GIB, 12, peaks, NOW).baselineGib, 2816 / 1024);
  const out = sizeLines(reading(peaks), {}, {}).join("\n");
  assert.match(out, /Agent baseline: 2\.5 GiB, the anonymous memory read during agent passes \(90th of 34 samples; highest 5\.1 GiB\); plus 10% is 2\.75 GiB\./);
});

test("with four samples the highest is used, and size says so", () => {
  const peaks = samples(4, 5222);
  assert.equal(measuredPeak(peaks, NOW)?.agentAnonMib, 5222);
  assert.match(sizeLines(reading(peaks), {}, {}).join("\n"), /Agent baseline: 5\.1 GiB, the anonymous memory read during agent passes \(highest of 4 samples\)/);
});

test("five samples are enough for a percentile, which is the nearest rank", () => {
  // ceil(90 x 5 / 100) = 5: the fifth of five is the highest. Ten samples: the ninth.
  assert.equal(measuredPeak(samples(5, 5222), NOW)?.agentAnonMib, 5222);
  assert.equal(measuredPeak(samples(10, 5222), NOW)?.agentAnonMib, 2560);
  const two = [...samples(8), sandbox(5222, 8), sandbox(5222, 9)];
  assert.equal(measuredPeak(two, NOW)?.agentAnonMib, 5222, "two of ten above the 90th still price at the highest");
});

test("a sandbox at rest is not a sample", () => {
  // Nine real samples and one at rest (1 MiB): the rest does not pull the percentile down or count.
  const peaks = [...samples(9), sandbox(1, 9)];
  assert.deepEqual(measuredPeak(peaks, NOW)?.figures.agentAnon, { mib: 2560, samples: 9, highest: 2560 });
});

test("the pool warning is not set by the outlier: a pool the usual samples fit does not warn", () => {
  // 14 GiB - 2 GiB = 12 GiB usable. 2 gates at 2.75 + 2 x 2.75 = 11 GiB fits; at the outlier's 5.61 GiB it would need 16.8 GiB.
  const peaks = samples(34, 5222);
  assert.deepEqual(poolWarnings(reading(peaks), {}, { maxSandboxes: 4, maxGates: 2 }), []);
  // The highest alone, as before, would warn.
  assert.equal(poolWarnings(reading(samples(4, 5222)), {}, { maxSandboxes: 4, maxGates: 2 }).length, 1);
});
