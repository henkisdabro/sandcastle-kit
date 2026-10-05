// The warning that a pool limit is above what `sandcastle size` recommends (src/size.ts `poolWarnings`,
// which doctor and the run's start line print), and the page-cache note on the measured peak. The
// readers are fakes (a made-up `docker info`, made-up peaks), so no Docker or model call is needed.
//
//   pnpm exec tsx --test test/size-pool-warning.test.ts

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
const { readAnonMib, recordPeak, readPeaks } = await import("../src/peaks.ts");
type Readers = Parameters<typeof sizeLines>[0];

const GIB = 2 ** 30;
const MIB = 2 ** 20;
const NOW = Date.parse("2026-05-10T00:00:00Z");
const peak = (peakMib: number, anonMib?: number) => ({ ts: "2026-05-09T00:00:00.000Z", project: "abc123", run: "r1", peakMib, ...(anonMib ? { anonMib } : {}) });
const reading = (over: Partial<Readers> = {}): Readers => ({
  // 9.8 GiB VM with 12 CPUs: a measured 5.25 GiB peak (x1.1 = 5.77) fits 1 sandbox; 12 CPUs fit 2 gates.
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
const measured = { peaks: () => [peak(5253)] };

test("measured peaks that fit fewer sandboxes than the default 6 warn with both numbers and the config key", () => {
  const lines = poolWarnings(reading(measured), {}, {});
  assert.equal(lines.length, 1, "the 2 default gates fit 12 CPUs: only the sandboxes warn");
  assert.match(lines[0], /^maxSandboxes is 6 \(default\), above the 1 that `sandcastle size` recommends from the measured sandbox peaks/);
  assert.ok(lines[0].includes(`set "maxSandboxes": 1 in ${join(config, "sandcastle-kit", "config.json")}`), lines[0]);
});

test("a gate limit above the CPUs' recommendation warns too, naming maxGates", () => {
  const small = reading({ ...measured, dockerInfo: () => JSON.stringify({ NCPU: 8, MemTotal: 9.8 * GIB, OperatingSystem: "OrbStack" }) });
  const lines = poolWarnings(small, {}, { maxSandboxes: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^maxGates is 2 \(default\), above the 1 that `sandcastle size` recommends/);
  assert.match(lines[0], /set "maxGates": 1 in /);
});

test("limits at or below the recommendation, from config.json or the environment, do not warn", () => {
  assert.deepEqual(poolWarnings(reading(measured), {}, { maxSandboxes: 1, maxGates: 1 }), []);
  assert.deepEqual(poolWarnings(reading(measured), { SANDCASTLE_MAX_SANDBOXES: "1" }, {}), []);
});

test("a limit from the environment says to change the variable, not config.json", () => {
  const [line] = poolWarnings(reading(measured), { SANDCASTLE_MAX_SANDBOXES: "4" }, {});
  assert.match(line, /^maxSandboxes is 4 \(environment SANDCASTLE_MAX_SANDBOXES\), above the 1/);
  assert.match(line, /change or unset SANDCASTLE_MAX_SANDBOXES/);
  assert.ok(!line.includes("config.json"), line);
});

test("a recommendation from the assumed figures does not warn", () => {
  assert.deepEqual(poolWarnings(reading(), {}, {}), [], "no peaks at all");
  assert.deepEqual(poolWarnings(reading({ peaks: () => [{ ...peak(5253), ts: "2026-01-01T00:00:00.000Z" }] }), {}, {}), [], "peaks older than 30 days are not measured");
});

test("an unreadable runtime gives no warning and no error", () => {
  assert.deepEqual(poolWarnings(reading({ ...measured, dockerInfo: () => undefined }), {}, {}), []);
  assert.deepEqual(poolWarnings(reading({ ...measured, dockerInfo: () => "not json" }), {}, {}), []);
});

test("size says the measured peak includes page cache, and gives the anonymous figure when recorded", () => {
  const without = sizeLines(reading(measured), {}, {}).join("\n");
  assert.match(without, /includes page cache/);
  assert.match(without, /no anonymous-memory \(no page cache\) figure was recorded/);
  const withAnon = sizeLines(reading({ peaks: () => [peak(5253, 3100)] }), {}, {}).join("\n");
  assert.match(withAnon, /includes page cache/);
  assert.match(withAnon, /anonymous memory \(no page cache\) read in them was at most 3\.03 GiB/);
});

test("memory.stat's anon figure is recorded beside memory.peak", async () => {
  const stat = `file 4000000000\nanon ${3000 * MIB + 1}\nslab 100\n`;
  const box = {
    exec: async (cmd: string) =>
      cmd.includes("memory.peak") ? { exitCode: 0, stdout: `${5000 * MIB}\n` } : cmd.includes("memory.stat") ? { exitCode: 0, stdout: stat } : { exitCode: 1, stdout: "" },
  };
  assert.equal(await readAnonMib(box), 3001);
  assert.equal(await readAnonMib({ exec: async () => ({ exitCode: 1, stdout: "" }) }), undefined, "no memory.stat");
  assert.equal(await readAnonMib({ exec: async () => ({ exitCode: 0, stdout: "file 1\n" }) }), undefined, "no anon line");
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-poolwarn-file-")), "peaks.jsonl");
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
