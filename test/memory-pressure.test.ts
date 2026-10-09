// Memory pressure (PSI, src/peaks.ts): the sandbox's `memory.pressure` `avg10` is read in the sampling loop, kept as the
// highest on the gate pass's result and the sandbox's peaks line, shown by `sandcastle size` and warned of in a run's
// report. The sandbox is a fake `exec` whose kernel files answer from variables the test sets; no Docker, model call or
// network. Expected figures are literals worked from the pressure files below.
//
//   pnpm test:file test/memory-pressure.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.HOME = process.env.XDG_CONFIG_HOME;
const { PRESSURE_WARN_FULL, readPeaks, readPressure, recordPeak, sampling } = await import("../src/peaks.ts");
const { runGates } = await import("../src/gates.ts");
const { measuredPeak, sizeLines } = await import("../src/size.ts");
const { pressureFromTimings, render } = await import("../src/report.ts");
type Readers = Parameters<typeof sizeLines>[0];
type Facts = import("../src/report.ts").Facts;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-pressure-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const MIB = 2 ** 20;
const GIB = 2 ** 30;
const NOW = Date.parse("2026-05-10T00:00:00Z");

/** The kernel's `memory.pressure` text, as a cgroup v2 file prints it. */
const psi = (some: number, full: number) =>
  `some avg10=${some.toFixed(2)} avg60=0.50 avg300=0.10 total=123456\nfull avg10=${full.toFixed(2)} avg60=0.20 avg300=0.05 total=65432\n`;

/** A sandbox whose kernel files answer from `k`; `pressure` is the file's text, or undefined for a kernel with no PSI. */
const kernel = () => {
  const k: { pressure: string | undefined } = { pressure: psi(0, 0) };
  const box = {
    worktreePath: "/made-up",
    exec: async (cmd: string) => {
      if (cmd.includes("memory.peak")) return { exitCode: 0, stdout: `${3000 * MIB}\n`, stderr: "" };
      if (cmd.includes("memory.stat")) return { exitCode: 0, stdout: `anon ${900 * MIB}\n`, stderr: "" };
      if (cmd.includes("memory.pressure")) return k.pressure === undefined ? { exitCode: 1, stdout: "", stderr: "No such file" } : { exitCode: 0, stdout: k.pressure, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { k, box };
};
const gateProject = () => ({ name: "made-up", root: TMP, gates: [{ name: "test", command: "run-tests" }] }) as Parameters<typeof runGates>[0];

test("readPressure reads the some and full avg10 from the cgroup's memory.pressure", async () => {
  const { k, box } = kernel();
  k.pressure = psi(12.34, 5.6);
  assert.deepEqual(await readPressure(box), { some: 12.34, full: 5.6 });
});

test("a kernel with no memory.pressure gives no figure, and the gate still passes with no pressure on its result or line", async () => {
  const { k, box } = kernel();
  k.pressure = undefined;
  assert.equal(await readPressure(box), undefined);
  const run = await runGates(gateProject(), box, "gates");
  assert.equal(run.gates[0].pass, true);
  assert.ok(!("pressureSome" in run) && !("pressureFull" in run), JSON.stringify(run));
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  await recordPeak(box, TMP, "run-1", file);
  const [line] = readPeaks(file);
  assert.ok(!("pressureSome" in line) && !("pressureFull" in line), JSON.stringify(line));
});

test("a gate pass carries the pressure read while it ran, and the sandbox's peaks line carries the highest of every pass", async () => {
  const { k, box } = kernel();
  k.pressure = psi(8.5, 2.25);
  const run = await runGates(gateProject(), box, "gates");
  assert.equal(run.pressureSome, 8.5);
  assert.equal(run.pressureFull, 2.25);
  // An agent pass in the same sandbox saw more; a second gate pass in a calm sandbox does not lower the line, and has its own figures.
  k.pressure = psi(30, 11);
  await sampling(box, "agent", async () => "done");
  k.pressure = psi(1, 0);
  const calm = await runGates(gateProject(), box, "gates");
  assert.equal(calm.pressureSome, 1);
  assert.ok(!("pressureFull" in calm), "a pressure of 0 is left off");
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  await recordPeak(box, TMP, "run-1", file);
  const [line] = readPeaks(file);
  assert.equal(line.pressureSome, 30);
  assert.equal(line.pressureFull, 11);
});

const peakLine = (over: Partial<ReturnType<typeof readPeaks>[number]> = {}) => ({ ts: "2026-05-09T10:00:00Z", project: "p1", run: "r1", peakMib: 3000, sampled: 2, anonMib: 900, agentAnonMib: 500, ...over });

test("measuredPeak keeps the highest pressure of the project's recent runs", () => {
  const m = measuredPeak([peakLine({ pressureSome: 3, pressureFull: 0.5 }), peakLine({ run: "r2", pressureSome: 9, pressureFull: 1.5 }), peakLine({ run: "r3" })], NOW);
  assert.equal(m?.pressureSome, 9);
  assert.equal(m?.pressureFull, 1.5);
  assert.ok(!("pressureFull" in measuredPeak([peakLine()], NOW)!));
});

const readers = (peaks: ReturnType<typeof readPeaks>): Readers => ({
  dockerInfo: () => JSON.stringify({ NCPU: 12, MemTotal: 16 * GIB, OperatingSystem: "OrbStack" }),
  hostMemory: () => 32 * GIB,
  hostCpus: () => 12,
  freeDisk: () => 100 * GIB,
  exists: () => false,
  home: () => "/home/user",
  platform: "darwin",
  peaks: () => peaks,
  projectId: () => "p1",
  now: () => NOW,
});
const sizeText = (peaks: ReturnType<typeof readPeaks>) => sizeLines(readers(peaks), {}, {}).join("\n");

test("size shows the highest pressure, and says full pressure at the threshold is a short VM and leaves the recommendation alone", () => {
  const calm = sizeText([peakLine({ pressureSome: 4.5, pressureFull: 0.75 })]);
  assert.match(calm, /Memory pressure \(PSI `avg10`.*\): some 4\.5%, full 0\.75%\.$/m);
  assert.doesNotMatch(calm, /short of memory/);
  const short = sizeText([peakLine({ pressureSome: 40, pressureFull: PRESSURE_WARN_FULL })]);
  assert.match(short, /some 40%, full 5%\. Full pressure at 5% or more .* short of memory at that pool size\. The limits below are not yet lowered for it/);
  const recommended = (text: string) => text.split("\n").filter((l) => /^  max(Sandboxes|Gates): \d+/.test(l));
  assert.deepEqual(recommended(short), recommended(calm));
});

test("size says so when no run recorded any pressure", () => {
  assert.match(sizeText([peakLine()]), /^Memory pressure: none recorded in those runs/m);
});

test("pressureFromTimings keeps the highest of the run's gate lines and names the pass of the highest full", () => {
  const text = [
    { run: "r1", issue: "7", phase: "gates", pressureSome: 10, pressureFull: 2 },
    { run: "r1", issue: "9", phase: "landing gates", pressureSome: 6, pressureFull: 7.5 },
    { run: "r1", issue: "", phase: "verify" },
    { run: "other", issue: "3", phase: "gates", pressureSome: 90, pressureFull: 80 },
  ].map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n";
  assert.deepEqual(pressureFromTimings(text, "r1"), { some: 10, full: 7.5, where: "ticket 9's landing gates" });
  assert.equal(pressureFromTimings(text, "none"), undefined);
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main", tracker: "github", started: "2026-09-30T06:41:00.000Z", finished: "2026-09-30T08:29:00.000Z", live: false, dryRun: false,
  verify: null, gateCount: 2, tickets: {}, runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, ...over,
});

test("a run's report warns when full pressure passed the threshold, and says nothing below it", () => {
  const high = render(facts({ pressure: { some: 20, full: 7.5, where: "ticket 9's landing gates" } }));
  assert.match(high, /^Memory pressure: high - full 7\.5% \(some 20%\) in a sandbox during ticket 9's landing gates/m);
  assert.match(high, /lower maxSandboxes or maxGates/);
  assert.doesNotMatch(render(facts({ pressure: { some: 20, full: 4.99, where: "x" } })), /Memory pressure/);
  assert.doesNotMatch(render(facts()), /Memory pressure/);
});

// `timed()` in src/burndown.ts and the landing gates' line in src/gates.ts need Docker to run, so the call sites are held by their text.
test("the timings lines of the run's steps and of a landing's gates carry the pass's pressure", async () => {
  const { readFileSync } = await import("node:fs");
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(burndown, /pressure = pressureOf\(result\);/);
  assert.match(burndown, /\.\.\.pressureFields\(pressure\),\n\s+\.\.\.\(red\?\.length/);
  const gates = readFileSync(new URL("../src/gates.ts", import.meta.url), "utf8");
  assert.match(gates, /const pressure = done \? pressureFields\(pressureOf\(result\)\) : \{\};/);
  assert.match(gates, /\.\.\.pressure,\n\s+\.\.\.\(red\?\.length/);
  assert.match(gates, /if \(green\) return \{[^\n]*\.\.\.pressureFields\(pressureOf\(run\)\)/);
});
