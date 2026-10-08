// The warning that the pool's limits need more memory than `sandcastle size` prices the VM at (src/size.ts `poolWarnings`,
// which doctor and the run's start line print), and the page-cache note on the measured peak. The
// readers are fakes (a made-up `docker info`, made-up peaks), so no Docker or model call is needed.
//
//   pnpm test:file test/size-pool-warning.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const config = mkdtempSync(join(tmpdir(), "sandcastle-poolwarn-cfg-"));
process.env.XDG_CONFIG_HOME = config;
process.env.HOME = config;
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-poolwarn-cache-"));
const { poolWarnings, sizeLines } = await import("../src/size.ts");
const { readAnonMib, recordPeak, readPeaks, samplePeak, sampling } = await import("../src/peaks.ts");
type Readers = Parameters<typeof sizeLines>[0];

const GIB = 2 ** 30;
const MIB = 2 ** 20;
const NOW = Date.parse("2026-05-10T00:00:00Z");
const peak = (peakMib: number, anonMib?: number, agentAnonMib?: number) => ({
  ts: "2026-05-09T00:00:00.000Z",
  project: "abc123",
  run: "r1",
  peakMib,
  sampled: 2,
  ...(anonMib ? { anonMib } : {}),
  ...(agentAnonMib ? { agentAnonMib } : {}),
});
const reading = (over: Partial<Readers> = {}): Readers => ({
  // 9.8 GiB VM with 12 CPUs: 7.8 GiB (7987.2 MiB) after the 2 GiB headroom.
  dockerInfo: () => JSON.stringify({ NCPU: 12, MemTotal: 9.8 * GIB, OperatingSystem: "OrbStack" }),
  hostMemory: () => 32 * GIB,
  hostCpus: () => 16,
  freeDisk: () => 120 * GIB,
  exists: () => false,
  home: () => "/home/user",
  platform: "darwin",
  now: () => NOW,
  ...over,
});
// Gate anon 3000 MiB, x1.1 = 3300 MiB, and no agent baseline: every sandbox at 3300 MiB, so 2 fit (6600 MiB).
const measured = { peaks: () => [peak(5253, 3000)] };
// The same gate with an agent baseline of 500 MiB (550 with the margin): 2 gates + floor(1387.2 / 550) = 4.
const withAgent = { peaks: () => [peak(5253, 3000, 500)] };

test("the default 6 and 2 priced at the gate's anon figure warn, naming what they need, what the VM has and the key", () => {
  const lines = poolWarnings(reading(measured), {}, {});
  assert.equal(lines.length, 1);
  // 2 x 3300 + 4 x 3300 MiB = 19800 MiB = 19.34 GiB.
  assert.match(lines[0], /^maxSandboxes 6 \(default\) with maxGates 2 \(default\) needs about 19\.34 GiB \(2 gates x 3\.22 GiB \+ 4 x 3\.22 GiB\), above the 7\.8 GiB this VM has/);
  assert.match(lines[0], /recommends maxSandboxes 2 and maxGates 2/);
  assert.ok(lines[0].includes(`set "maxSandboxes": 2 in ${join(config, "sandcastle-kit", "config.json")}`), lines[0]);
  assert.ok(!lines[0].includes(`"maxGates"`), `the gates are at the recommendation: ${lines[0]}`);
});

test("too many gates for the memory warn too, naming maxGates", () => {
  const lines = poolWarnings(reading(withAgent), {}, { maxSandboxes: 4, maxGates: 3 });
  assert.equal(lines.length, 1);
  // 3 x 3300 + 1 x 550 MiB = 10450 MiB = 10.21 GiB.
  assert.match(lines[0], /needs about 10\.21 GiB \(3 gates x 3\.22 GiB \+ 1 x 0\.54 GiB\)/);
  assert.match(lines[0], /set "maxGates": 2 in /);
  assert.ok(!lines[0].includes(`"maxSandboxes"`), lines[0]);
});

test("a pool the priced figures fit, from config.json or the environment, does not warn", () => {
  assert.deepEqual(poolWarnings(reading(measured), {}, { maxSandboxes: 2, maxGates: 2 }), []);
  assert.deepEqual(poolWarnings(reading(measured), { SANDCASTLE_MAX_SANDBOXES: "2" }, {}), []);
  assert.deepEqual(poolWarnings(reading(withAgent), {}, { maxSandboxes: 4, maxGates: 2 }), []);
  // More gates than sandboxes never run at once: 2 sandboxes with 3 gates are 2 gates' worth.
  assert.deepEqual(poolWarnings(reading(measured), {}, { maxSandboxes: 2, maxGates: 3 }), []);
});

test("a limit from the environment says to change the variable, not config.json", () => {
  const [line] = poolWarnings(reading(measured), { SANDCASTLE_MAX_SANDBOXES: "4" }, {});
  assert.match(line, /^maxSandboxes 4 \(environment SANDCASTLE_MAX_SANDBOXES\) with maxGates 2 \(default\)/);
  assert.match(line, /change or unset SANDCASTLE_MAX_SANDBOXES/);
  assert.ok(!line.includes("config.json"), line);
});

test("a recommendation from the assumed figures or from memory.peak alone does not warn", () => {
  assert.deepEqual(poolWarnings(reading(), {}, {}), [], "no peaks at all");
  assert.deepEqual(poolWarnings(reading({ peaks: () => [peak(5253)] }), {}, {}), [], "memory.peak counts page cache: no anon figure, no warning");
  assert.deepEqual(poolWarnings(reading({ peaks: () => [{ ...peak(5253, 3000), ts: "2026-01-01T00:00:00.000Z" }] }), {}, {}), [], "peaks older than 30 days are not measured");
});

test("an unreadable runtime gives no warning and no error", () => {
  assert.deepEqual(poolWarnings(reading({ ...measured, dockerInfo: () => undefined }), {}, {}), []);
  assert.deepEqual(poolWarnings(reading({ ...measured, dockerInfo: () => "not json" }), {}, {}), []);
});

test("size says memory.peak includes page cache, and prices the gate from the anonymous figure when recorded", () => {
  const without = sizeLines(reading({ peaks: () => [peak(5253)] }), {}, {}).join("\n");
  assert.match(without, /Gate figure: 5\.13 GiB, cgroup `memory\.peak` \(highest of 1 sample\), which includes page cache/);
  assert.match(without, /no pool warning is given until one is/);
  const withAnon = sizeLines(reading(measured), {}, {}).join("\n");
  assert.match(withAnon, /Gate figure: 2\.93 GiB, the anonymous memory \(no page cache\) read during gates \(highest of 1 sample\); plus 10% is 3\.22 GiB\. \(Their cgroup `memory\.peak`, page cache included, was 5\.13 GiB\.\)/);
});

test("memory.stat's anon figure read while a gate pass runs is recorded beside memory.peak", async () => {
  const stat = `file 4000000000\nanon ${3000 * MIB + 1}\nslab 100\n`;
  const box = {
    exec: async (cmd: string) =>
      cmd.includes("memory.peak") ? { exitCode: 0, stdout: `${5000 * MIB}\n` } : cmd.includes("memory.stat") ? { exitCode: 0, stdout: stat } : { exitCode: 1, stdout: "" },
  };
  assert.equal(await readAnonMib(box), 3001);
  assert.equal(await readAnonMib({ exec: async () => ({ exitCode: 1, stdout: "" }) }), undefined, "no memory.stat");
  assert.equal(await readAnonMib({ exec: async () => ({ exitCode: 0, stdout: "file 1\n" }) }), undefined, "no anon line");
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-poolwarn-file-")), "peaks.jsonl");
  // The read as the pass starts; after it and at close, `anon` is the sandbox at rest and is not recorded (src/peaks.ts).
  await sampling(box, "gate", async () => {});
  assert.equal(await samplePeak(box), 5000);
  assert.equal(await recordPeak(box, "/made-up/root", "run-1", file), 5000);
  const [line] = readPeaks(file);
  assert.equal(line.peakMib, 5000);
  assert.equal(line.anonMib, 3001);
  assert.match(readFileSync(file, "utf8"), /"anonMib":3001/);
});

test("a sandbox whose memory.stat is missing still records its peak, with no anonMib", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-poolwarn-file-")), "peaks.jsonl");
  const box = { exec: async (cmd: string) => (cmd.includes("memory.peak") ? { exitCode: 0, stdout: `${800 * MIB}\n` } : { exitCode: 1, stdout: "" }) };
  assert.equal(await recordPeak(box, "/made-up/root", "run-1", file), 800);
  assert.ok(!("anonMib" in readPeaks(file)[0]));
});
