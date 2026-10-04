// Sandbox peak memory (src/peaks.ts) and the limit `sandcastle size` draws from it (src/size.ts). The
// sandbox is a fake `exec` answering for the kernel's `memory.peak`, the cache directory a temp
// XDG_CACHE_HOME, so no Docker, model call or network is needed.
//
//   pnpm exec tsx --test test/peaks.test.ts

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cache = mkdtempSync(join(tmpdir(), "sandcastle-peaks-cache-"));
process.env.XDG_CACHE_HOME = cache;
const config = mkdtempSync(join(tmpdir(), "sandcastle-peaks-cfg-"));
process.env.XDG_CONFIG_HOME = config;
process.env.HOME = config;
const { PEAKS_FILE, peakOf, projectId, readPeakMib, readPeaks, recordPeak, samplePeak } = await import("../src/peaks.ts");
const { runGates } = await import("../src/gates.ts");
const { measuredPeak, recommend, sizeLines } = await import("../src/size.ts");
const { typicalTimes } = await import("../src/run.ts");
type PeakLine = ReturnType<typeof readPeaks>[number];

const GIB = 2 ** 30;
const MIB = 2 ** 20;
const DAY = 86_400_000;

/** A sandbox whose gates pass and whose `memory.peak` reads `peak` (bytes), or is missing when undefined. */
const sandbox = (peak: (() => number) | undefined) => ({
  worktreePath: "/made-up",
  exec: async (cmd: string) => {
    if (cmd.includes("memory.peak")) return peak ? { exitCode: 0, stdout: `${peak()}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "No such file" };
    return { exitCode: 0, stdout: "", stderr: "" };
  },
});
const project = (root: string) => ({ name: "made-up", root, gates: [{ name: "test", command: "true" }] }) as Parameters<typeof runGates>[0];

test("a gate pass reads the kernel's high-water mark into the result, in MiB rounded up", async () => {
  const run = await runGates(project(mkdtempSync(join(tmpdir(), "sandcastle-peaks-root-"))), sandbox(() => 1400 * MIB + 1), "gates");
  assert.equal(run.peakMib, 1401);
  assert.equal(run.gates[0].pass, true);
  // What timed() in src/burndown.ts puts on the step's timings line.
  assert.equal(peakOf(run), 1401);
  assert.equal(peakOf(undefined), undefined, "a step with no result (the image, a requeue) carries none");
  assert.equal(peakOf({ gates: [] }), undefined);
});

test("a missing memory.peak records nothing and does not fail the pass", async () => {
  const box = sandbox(undefined);
  const run = await runGates(project(mkdtempSync(join(tmpdir(), "sandcastle-peaks-root-"))), box, "gates");
  assert.equal(run.gates[0].pass, true);
  assert.ok(!("peakMib" in run));
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  assert.equal(await recordPeak(box, "/made-up/root", "run-1", file), undefined);
  assert.ok(!existsSync(file), "no line, and no file");
  // Unreadable in other ways: an exec that throws, text that is not a number, a sandbox that never answers.
  assert.equal(await readPeakMib({ exec: async () => { throw new Error("sandbox gone"); } }), undefined);
  assert.equal(await readPeakMib({ exec: async () => ({ exitCode: 0, stdout: "max\n" }) }), undefined);
  assert.equal(await readPeakMib({ exec: async () => ({ exitCode: 0, stdout: "0\n" }) }), undefined);
});

test("the largest reading of a sandbox is kept, and one line per sandbox goes to peaks.jsonl", async () => {
  const readings = [900, 1500, 700];
  const box = sandbox(() => readings.shift()! * MIB);
  assert.equal(await samplePeak(box), 900);
  assert.equal(await samplePeak(box), 1500);
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "nested", "peaks.jsonl");
  const now = new Date("2026-05-01T10:00:00Z");
  assert.equal(await recordPeak(box, "/made-up/root", "2026-05-01T09:00:00.000Z", file, now), 1500, "the last reading (700) does not lower it");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ts: "2026-05-01T10:00:00.000Z", project: projectId("/made-up/root"), run: "2026-05-01T09:00:00.000Z", peakMib: 1500 });
  assert.deepEqual(readPeaks(file), [JSON.parse(lines[0])]);
});

test("peaks.jsonl carries no path and no project name", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-root-")), "client-acme-portal");
  mkdirSync(root);
  await recordPeak(sandbox(() => 800 * MIB), root, "run-1");
  const text = readFileSync(PEAKS_FILE, "utf8");
  assert.ok(text.includes(projectId(root)));
  assert.ok(!text.includes("client-acme-portal"), text);
  assert.ok(!text.includes(root), text);
  assert.ok(!text.includes(tmpdir()), text);
  assert.deepEqual(Object.keys(JSON.parse(text.trim().split("\n")[0])).sort(), ["peakMib", "project", "run", "ts"]);
  assert.match(projectId(root), /^[0-9a-f]{12}$/);
  assert.equal(PEAKS_FILE, join(cache, "sandcastle-kit", "peaks.jsonl"), "beside the live-runs directory, not inside it");
});

test("a half-written or foreign line in peaks.jsonl is skipped", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  writeFileSync(file, '{"ts":"2026-05-01T00:00:00Z","project":"a","run":"r","peakMib":500}\nnot json\n{"ts":"x","project":"a","peakMib":1}\n{"ts":"2026-05-01T00:00:00Z","project":"a","peakMib":-3}\n{"ts":"2026-05-0');
  assert.equal(readPeaks(file).length, 1);
  assert.deepEqual(readPeaks(join(tmpdir(), "sandcastle-peaks-none", "peaks.jsonl")), []);
});

// ---- the recommend rules ----

const NOW = Date.parse("2026-06-30T12:00:00Z");
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const line = (project: string, daysAgo: number, peakMib: number, run = `run-${project}-${daysAgo}`): PeakLine => ({ ts: at(daysAgo), project, run, peakMib });

test("recommend: no data keeps the assumed figure", () => {
  const rec = recommend(8 * GIB, 8, [], NOW);
  assert.equal(rec.measured, undefined);
  assert.equal(rec.perSandboxGib, 1.5);
  assert.equal(rec.sandboxes, 4);
  assert.equal(measuredPeak([], NOW), undefined);
});

test("recommend: one project's highest peak plus 10%", () => {
  const peaks = [line("a", 1, 1000), line("a", 2, 1400), line("a", 3, 900)];
  const m = measuredPeak(peaks, NOW)!;
  assert.deepEqual(m, { peakMib: 1400, project: "a", runs: 3, perSandboxMib: 1540 });
  const rec = recommend(10 * GIB, 16, peaks, NOW);
  // floor((10 - 2) / (1540 / 1024)) = floor(5.32) = 5
  assert.equal(rec.byMemory, 5);
  assert.equal(rec.sandboxes, 5);
  assert.match(rec.sandboxesBy, /^memory: floor\(\(10 GiB - 2 GiB\) \/ 1\.5 GiB\) = 5/);
});

test("recommend: a project with no measured run in 30 days is ignored", () => {
  const stale = [line("old", 31, 6000), line("old", 40, 6000)];
  assert.equal(measuredPeak(stale, NOW), undefined);
  const mixed = measuredPeak([...stale, line("fresh", 5, 1000)], NOW)!;
  assert.equal(mixed.project, "fresh");
  assert.equal(mixed.peakMib, 1000);
  // Exactly 30 days is still in.
  assert.equal(measuredPeak([line("edge", 30, 1000)], NOW)?.project, "edge");
});

test("recommend: a runaway run older than the last 5 is ignored; one inside them counts", () => {
  const dropped = measuredPeak([line("a", 20, 9000), ...[1, 2, 3, 4, 5].map((d, i) => line("a", d, 1000 + i * 10))], NOW)!;
  assert.equal(dropped.peakMib, 1040, "the sixth-newest run (9000) is out");
  assert.equal(dropped.runs, 5);
  const inside = measuredPeak([line("a", 20, 9000), ...[1, 2, 3, 4].map((d) => line("a", d, 1000))], NOW)!;
  assert.equal(inside.peakMib, 9000, "five runs are the last 5, the old one among them");
  assert.equal(inside.runs, 5);
});

test("recommend: a run is its sandboxes' lines together, and counts once", () => {
  const peaks = [
    { ts: at(1), project: "a", run: "r1", peakMib: 800 },
    { ts: at(1), project: "a", run: "r1", peakMib: 1200 },
    { ts: at(1), project: "a", run: "r1", peakMib: 700 },
    { ts: at(2), project: "a", run: "r0", peakMib: 600 },
  ];
  const m = measuredPeak(peaks, NOW)!;
  assert.equal(m.runs, 2);
  assert.equal(m.peakMib, 1200);
});

test("recommend: of several projects the highest wins, and names itself", () => {
  const peaks = [line("a", 1, 1000), line("b", 2, 2200), line("c", 3, 1500), line("old", 45, 8000)];
  const m = measuredPeak(peaks, NOW)!;
  assert.deepEqual([m.project, m.peakMib, m.runs, m.perSandboxMib], ["b", 2200, 1, 2420]);
});

// ---- the command's output ----

const GIB_INFO = { NCPU: 8, MemTotal: 12 * GIB, OperatingSystem: "OrbStack", Name: "orbstack" };
const reading = (over: Record<string, unknown> = {}) => ({
  dockerInfo: () => JSON.stringify(GIB_INFO),
  hostMemory: () => 64 * GIB,
  hostCpus: () => 16,
  freeDisk: () => 100 * GIB,
  exists: () => false,
  home: () => "/home/user",
  platform: "darwin" as const,
  ...over,
});

test("size with measured peaks prints the measured line and sizes by it", () => {
  const peaks = [line("a", 1, 1400), line("a", 2, 1000), line("b", 3, 300)];
  const out = sizeLines(reading({ peaks: () => peaks, now: () => NOW, projectId: () => "b" }), {}, {}).join("\n");
  assert.match(out, /Measured: the last 2 measured runs of project a peaked at 1\.37 GiB in one sandbox, the highest of any project in the last 30 days; plus 10% is 1\.5 GiB\./);
  assert.match(out, /memory fits 6 sandboxes, so maxSandboxes is 6\./);
  assert.match(out, /Assumed, not measured: 2 GiB headroom, 6 CPUs per gate/);
  assert.ok(!out.includes("no run has been sampled yet"));
  assert.match(out, /maxSandboxes: 6 {2}\(memory: floor\(\(12 GiB - 2 GiB\) \/ 1\.5 GiB\) = 6; CPUs allow 8\)/);
  const mine = sizeLines(reading({ peaks: () => peaks, now: () => NOW, projectId: () => "a" }), {}, {}).join("\n");
  assert.match(mine, /of this project peaked/);
});

test("size with no peaks prints the assumed-figure line as before", () => {
  const out = sizeLines(reading({ peaks: () => [], now: () => NOW }), {}, {}).join("\n");
  assert.match(out, /^Assumed, not measured \(no run has been sampled yet\): 2 GiB headroom, 1\.5 GiB per sandbox, 6 CPUs per gate, at most 12 sandboxes\.$/m);
  assert.ok(!out.includes("Measured:"));
  // Readers that know nothing of peaks (older callers) are the same.
  assert.equal(sizeLines(reading(), {}, {}).join("\n"), out);
});

// ---- the timings line ----

test("typicalTimes ignores the peakMib field on a timings line", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-peaks-root-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const timings = join(root, ".sandcastle/logs/timings.jsonl");
  const lines = [
    { ts: at(1), run: "r1", project: "made-up", issue: "7", phase: "implement", ms: 60_000, ok: true },
    { ts: at(1), run: "r1", project: "made-up", issue: "7", phase: "gates", ms: 30_000, ok: true },
  ];
  const p = { name: "made-up", root } as unknown as Parameters<typeof typicalTimes>[0];
  writeFileSync(timings, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const without = typicalTimes(p);
  writeFileSync(timings, "");
  for (const l of lines) appendFileSync(timings, JSON.stringify({ ...l, ...(l.phase === "gates" ? { peakMib: 1400 } : {}) }) + "\n");
  assert.deepEqual(typicalTimes(p), without);
  assert.deepEqual(without, { implement: 60, gates: 30, issue: 90 });
});
