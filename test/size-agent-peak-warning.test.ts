// A cache-inclusive agent baseline (`agentMib`, `memory.peak`) beside an anonymous gate figure gives no pool warning
// and `sandcastle size` says why it may sit above the gate figure; with both figures anonymous the pool still warns.
// The readers are fakes (a made-up `docker info`, made-up peaks): no Docker or model call.
//
//   node --test test/size-agent-peak-warning.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const config = mkdtempSync(join(tmpdir(), "sandcastle-agentpeak-cfg-"));
process.env.XDG_CONFIG_HOME = config;
process.env.HOME = config;
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-agentpeak-cache-"));
const { poolWarnings, sizeLines, recommend } = await import("../src/size.ts");
type Readers = Parameters<typeof sizeLines>[0];

const GIB = 2 ** 30;
const NOW = Date.parse("2026-05-10T00:00:00Z");
const line = (figures: { peakMib: number; anonMib?: number; agentMib?: number; agentAnonMib?: number }) => ({
  ts: "2026-05-09T00:00:00.000Z",
  project: "abc123",
  run: "r1",
  sampled: 2,
  ...figures,
});
const reading = (peaks: ReturnType<typeof line>[]): Readers => ({
  // 9.8 GiB VM with 12 CPUs: 7.8 GiB after the 2 GiB headroom.
  dockerInfo: () => JSON.stringify({ NCPU: 12, MemTotal: 9.8 * GIB, OperatingSystem: "OrbStack" }),
  hostMemory: () => 32 * GIB,
  hostCpus: () => 16,
  freeDisk: () => 120 * GIB,
  exists: () => false,
  home: () => "/home/user",
  platform: "darwin",
  peaks: () => peaks,
  now: () => NOW,
});

// Gate anon 3000 MiB (3300 with the margin), agent peak 5000 MiB (5500): the agent outweighs the gate.
const unmarked = [line({ peakMib: 6000, anonMib: 3000, agentMib: 5000 })];
const marked = [line({ peakMib: 6000, anonMib: 3000, agentMib: 5000, agentAnonMib: 1000 })];

test("an anonymous gate figure beside a memory.peak agent baseline gives no pool warning", () => {
  assert.equal(recommend(9.8 * GIB, 12, unmarked, NOW).baselineFrom, "agent-peak");
  assert.deepEqual(poolWarnings(reading(unmarked), {}, {}), []);
  assert.deepEqual(poolWarnings(reading(unmarked), {}, { maxSandboxes: 12, maxGates: 4 }), []);
});

test("size says the memory.peak agent baseline includes page cache, may sit above the gate figure and will switch to anonymous memory", () => {
  const out = sizeLines(reading(unmarked), {}, {}).join("\n");
  assert.match(out, /Agent baseline: 4\.88 GiB, `memory\.peak` read before the first gate pass; plus 10% is 5\.37 GiB\./);
  assert.match(out, /includes page cache/);
  assert.match(out, /agents run the project's test suite themselves, so it may sit above the gate figure/);
  assert.match(out, /switches to anonymous memory once a run records agent samples/);
});

test("an anonymous gate figure with a marked anonymous agent figure still warns for a pool that does not fit", () => {
  assert.equal(recommend(9.8 * GIB, 12, marked, NOW).baselineFrom, "agent-anon");
  const lines = poolWarnings(reading(marked), {}, {});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^maxSandboxes 6 \(default\) with maxGates 2 \(default\) needs about /);
  const out = sizeLines(reading(marked), {}, {}).join("\n");
  assert.match(out, /Agent baseline: 0\.98 GiB, the anonymous memory read during agent passes/);
  assert.ok(!out.includes("sit above the gate figure"), out);
});
