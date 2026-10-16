// CPU pressure (src/peaks.ts): the machine-wide figure the host reads (`readMachineCpu`) and the sandbox cgroup's own
// `cpu.pressure` are read beside memory pressure in every gate pass, kept as the pass's highest and mean on its result,
// its timings line and the sandbox's peaks line, and the closing summary says when the machine's mean was high. The
// sandbox is a fake `exec` and the host a made-up one; no Docker, model call or network. Expected figures are literals
// worked from the fixtures below.
//
//   pnpm test:file test/cpu-pressure.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { cleanup } from "./pool-sim.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.HOME = process.env.XDG_CONFIG_HOME;
const { CPU_PRESSURE_HIGH, cpuFields, cpuHigh, cpuOf, parsePressure, readCpuPressure, readMachineCpu, readPeaks, recordPeak } = await import("../src/peaks.ts");
const { runGates, timingLines, stepTimes } = await import("../src/gates.ts");
const { cpuFromTimings, render } = await import("../src/report.ts");
type Facts = import("../src/report.ts").Facts;
type MachineCpu = import("../src/peaks.ts").MachineCpu;

afterEach(cleanup);
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-cpu-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const MIB = 2 ** 20;

/** A `*.pressure` file as the kernel prints it: a `some` line and, as `memory.pressure` has, a `full` one. */
const psi = (some: number, avg60 = 8) =>
  `some avg10=${some.toFixed(2)} avg60=${avg60.toFixed(2)} avg300=2.00 total=123\nfull avg10=1.00 avg60=0.50 avg300=0.10 total=45\n`;

/** A sandbox whose `cpu.pressure` answers with `cpu.text` (undefined: the file is missing). */
const kernel = () => {
  const cpu: { text: string | undefined } = { text: undefined };
  const box = {
    worktreePath: "/made-up",
    exec: async (cmd: string) => {
      if (cmd.includes("memory.peak")) return { exitCode: 0, stdout: `${500 * MIB}\n`, stderr: "" };
      if (cmd.includes("cpu.pressure")) return cpu.text === undefined ? { exitCode: 1, stdout: "", stderr: "No such file" } : { exitCode: 0, stdout: cpu.text, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { cpu, box };
};
const gateProject = () => ({ name: "made-up", root: TMP, gates: [{ name: "test", command: "run-tests" }] }) as Parameters<typeof runGates>[0];
/** `box` with a gate that takes just over one sampling interval, so a pass reads twice. */
const slowGate = (box: ReturnType<typeof kernel>["box"]) => ({
  ...box,
  exec: async (cmd: string) => {
    if (cmd.includes("run-tests")) await new Promise((resolve) => setTimeout(resolve, 10_100));
    return box.exec(cmd);
  },
});
/** The step's line as `timed()` in src/burndown.ts builds it. */
const stepLine = (result: Awaited<ReturnType<typeof runGates>>) => ({
  ts: "2026-01-01T00:00:00.000Z", run: "run-1", project: "made-up", issue: "7", phase: "gates", ...stepTimes(60_000, result), ok: !result.failure, ...cpuFields(cpuOf(result)),
});
/** A machine reader that answers each call with the next figure, then the last again. */
const readings = (...avg10: number[]) => {
  let i = 0;
  return () => ({ avg10: avg10[Math.min(i++, avg10.length - 1)]!, avg60: 0 }) as MachineCpu;
};

test("the PSI parser reads the some line's avg10 and avg60, and nothing from a missing or malformed one", () => {
  assert.deepEqual(parsePressure("some avg10=12.50 avg60=8.00 avg300=2.00 total=123\nfull avg10=3.00 avg60=1.00 avg300=0.00 total=9\n"), { avg10: 12.5, avg60: 8 });
  assert.equal(parsePressure("full avg10=3.00 avg60=1.00 avg300=0.00 total=9\n"), undefined);
  assert.equal(parsePressure("some avg10=oops avg60=8.00\n"), undefined);
  assert.equal(parsePressure("some avg60=8.00\n"), undefined);
  assert.equal(parsePressure(""), undefined);
});

test("readCpuPressure gives the sandbox cgroup's some avg10, and no reading when its cat fails", async () => {
  const { cpu, box } = kernel();
  cpu.text = psi(12.5);
  assert.equal(await readCpuPressure(box), 12.5);
  cpu.text = undefined;
  assert.equal(await readCpuPressure(box), undefined);
  assert.equal(await readCpuPressure({ exec: async () => { throw new Error("gone"); } }), undefined);
});

test("readMachineCpu reads Linux's /proc/pressure/cpu, and gives nothing where it is missing", () => {
  const seen: string[] = [];
  const linux = { platform: "linux", readFile: (path: string) => (seen.push(path), psi(12.34, 8.06)) };
  assert.deepEqual(readMachineCpu(linux), { avg10: 12.3, avg60: 8.1 });
  assert.deepEqual(seen, ["/proc/pressure/cpu"]);
  const missing = { platform: "linux", readFile: () => { throw new Error("ENOENT"); } };
  assert.equal(readMachineCpu(missing), undefined);
  assert.equal(readMachineCpu({ platform: "linux", readFile: () => "garbage" }), undefined);
});

test("readMachineCpu estimates macOS's pressure from the load average, marked as an estimate, and gives nothing on another platform", () => {
  // (30 - 16) / 30 = 46.67%
  assert.deepEqual(readMachineCpu({ platform: "darwin", loadavg: () => [30, 20, 10], cpus: () => 16 }), { avg10: 46.7, avg60: 46.7, estimate: true });
  assert.deepEqual(readMachineCpu({ platform: "darwin", loadavg: () => [12, 20, 10], cpus: () => 16 }), { avg10: 0, avg60: 0, estimate: true });
  assert.deepEqual(readMachineCpu({ platform: "darwin", loadavg: () => [0, 0, 0], cpus: () => 16 }), { avg10: 0, avg60: 0, estimate: true });
  // 60% needs a load of 2.5 times the cores.
  assert.equal(readMachineCpu({ platform: "darwin", loadavg: () => [40, 0, 0], cpus: () => 16 })?.avg10, 60);
  assert.equal(readMachineCpu({ platform: "win32", readFile: () => psi(50) }), undefined);
});

test("with no injected host the machine reading is switched off in a test process, and an injected host is still read", () => {
  assert.equal(process.env.SANDCASTLE_TEST_MACHINE_CPU, "none");
  assert.equal(readMachineCpu(), undefined);
  assert.deepEqual(readMachineCpu({ platform: "linux", readFile: () => psi(9) }), { avg10: 9, avg60: 8 });
});

test("a gate pass carries the highest and the mean of the machine's CPU pressure, and the sandbox's own beside it", async () => {
  const { cpu, box } = kernel();
  cpu.text = psi(5.5);
  const run = await runGates(gateProject(), box, "gates", false, { machineCpu: readings(70, 50) });
  // One read as the pass starts; a pass this short has no second one, so the mean is the first reading's.
  assert.equal(run.gates[0]!.pass, true);
  assert.equal(run.cpuSome, 5.5);
  assert.equal(run.cpuSomeMean, 5.5);
  assert.equal(run.cpuMachine, 70);
  assert.equal(run.cpuMachineMean, 70);
  assert.ok(!("cpuEstimate" in run));
});

test("the highest and the mean cover every reading of the pass, and the estimate is marked", async () => {
  const { box } = kernel();
  const reads = [70, 50];
  let i = 0;
  const sandbox = slowGate(box);
  const run = await runGates(gateProject(), sandbox, "gates", false, { machineCpu: () => ({ avg10: reads[i++]!, avg60: 0, estimate: true }) });
  assert.equal(run.cpuMachine, 70);
  assert.equal(run.cpuMachineMean, 60);
  assert.equal(run.cpuEstimate, true);
  assert.ok(!("cpuSome" in run) && !("cpuSomeMean" in run), "no reading from the sandbox's cgroup, no figure");
});

test("with no reading from either, the pass carries no CPU field", async () => {
  const { box } = kernel();
  const run = await runGates(gateProject(), box, "gates", false, { machineCpu: () => undefined });
  assert.equal(run.gates[0]!.pass, true);
  assert.deepEqual(Object.keys(run).filter((k) => k.startsWith("cpu")), []);
  // A pressure of 0 is left off, as memory pressure's is.
  const idle = await runGates(gateProject(), box, "gates", false, { machineCpu: () => ({ avg10: 0, avg60: 0 }) });
  assert.deepEqual(Object.keys(idle).filter((k) => k.startsWith("cpu")), []);
  // The default reader is the switched-off one in a test process.
  const bare = await runGates(gateProject(), box, "gates");
  assert.deepEqual(Object.keys(bare).filter((k) => k.startsWith("cpu")), []);
});

test("a red gate re-run inside its slot writes each run's own CPU figures on its own line", async () => {
  let red = 1;
  const box = {
    exec: async (cmd: string) => {
      const fails = cmd.includes("run-tests") && red-- > 0;
      return { exitCode: fails ? 1 : 0, stdout: "", stderr: fails ? "boom" : "" };
    },
  };
  const result = await runGates(gateProject(), box, "gates", false, { machineCpu: readings(80, 20) }, false, undefined, true);
  const [first, second] = timingLines(stepLine(result), result);
  assert.deepEqual([first!.cpuMachine, first!.cpuMachineMean], [80, 80]);
  assert.deepEqual([second!.cpuMachine, second!.cpuMachineMean], [20, 20]);
  // The earlier run's line never carries the later run's figures, where it has none of its own.
  red = 1;
  const later = await runGates(gateProject(), box, "gates", false, { machineCpu: readings(0, 30) }, false, undefined, true);
  const [redLine, greenLine] = timingLines(stepLine(later), later);
  assert.ok(!("cpuMachine" in redLine!) && !("cpuMachineMean" in redLine!), JSON.stringify(redLine));
  assert.deepEqual([greenLine!.cpuMachine, greenLine!.cpuMachineMean], [30, 30]);
});

test("recordPeak writes the highest CPU figures on the sandbox's peaks line and readPeaks reads them back", async () => {
  const { cpu, box } = kernel();
  cpu.text = psi(40);
  await runGates(gateProject(), box, "gates", false, { machineCpu: () => ({ avg10: 33.3, avg60: 0, estimate: true }) });
  const file = join(mkdtempSync(join(TMP, "peaks-")), "peaks.jsonl");
  await recordPeak(box, TMP, "run-1", file);
  const [line] = readPeaks(file);
  assert.deepEqual([line!.cpuSome, line!.cpuMachine, line!.cpuEstimate], [40, 33.3, true]);
  // A sandbox that read none writes none.
  const quiet = kernel();
  await runGates(gateProject(), quiet.box, "gates", false, { machineCpu: () => undefined });
  await recordPeak(quiet.box, TMP, "run-2", file);
  const second = readPeaks(file)[1]!;
  assert.ok(!("cpuSome" in second) && !("cpuMachine" in second) && !("cpuEstimate" in second), JSON.stringify(second));
});

test("cpuHigh judges the recorded, rounded mean against the constant", async () => {
  assert.equal(CPU_PRESSURE_HIGH, 60);
  assert.equal(cpuHigh({ cpuMachineMean: 60 }), true);
  assert.equal(cpuHigh({ cpuMachineMean: 59.9 }), false);
  assert.equal(cpuHigh({}), false);
  assert.equal(cpuHigh(undefined), false);
  // The highest alone does not make a pass high.
  assert.equal(cpuHigh({ cpuMachine: 95, cpuMachineMean: 30 }), false);
  // 59.96 and 59.96 record a mean of 60, and that is the figure judged.
  const { box } = kernel();
  const reads = [59.96, 59.96];
  let i = 0;
  const run = await runGates(gateProject(), slowGate(box), "gates", false, { machineCpu: () => ({ avg10: reads[i++]!, avg60: 0 }) });
  assert.equal(run.cpuMachineMean, 60);
  assert.equal(cpuHigh(run), true);
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main", tracker: "github", started: "2026-09-30T06:41:00.000Z", finished: "2026-09-30T08:29:00.000Z", live: false, dryRun: false,
  verify: null, gateCount: 2, tickets: {}, runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, ...over,
});

test("cpuFromTimings names the pass with the highest machine mean, and its estimate", () => {
  const text = [
    { run: "r1", issue: "7", phase: "gates", cpuMachineMean: 40 },
    { run: "r1", issue: "9", phase: "landing gates", cpuMachineMean: 72.5, cpuMachine: 90, cpuEstimate: true },
    { run: "r1", issue: "", phase: "verify", cpuMachineMean: 72.5 },
    { run: "r1", issue: "3", phase: "gates", cpuSomeMean: 99 },
    { run: "other", issue: "3", phase: "gates", cpuMachineMean: 99 },
  ].map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n";
  assert.deepEqual(cpuFromTimings(text, "r1"), { mean: 72.5, where: "ticket 9's landing gates", estimate: true });
  assert.deepEqual(cpuFromTimings(JSON.stringify({ run: "r1", issue: "", phase: "verify", cpuMachineMean: 61 }), "r1"), { mean: 61, where: "verify" });
  assert.equal(cpuFromTimings(text, "none"), undefined);
});

test("the closing summary says when the machine's CPU pressure was high, names the pass and the fix, and says nothing below", () => {
  const high = render(facts({ cpu: { mean: 60, where: "ticket 9's gates" } }));
  assert.match(high, /^CPU pressure: high - .*averaged 60% over ticket 9's gates/m);
  assert.match(high, /other work on the machine/);
  assert.match(high, /sandcastle gates/);
  assert.match(high, /lower maxSandboxes/);
  assert.doesNotMatch(high, /estimate/);
  assert.match(render(facts({ cpu: { mean: 71.2, where: "verify", estimate: true } })), /^CPU pressure: high - .*averaged 71\.2% \(an estimate from the load average\) over verify/m);
  assert.doesNotMatch(render(facts({ cpu: { mean: 59.9, where: "verify" } })), /CPU pressure/);
  assert.doesNotMatch(render(facts()), /CPU pressure/);
  // Right after the memory pressure line.
  const both = render(facts({ pressure: { some: 20, full: 7.5, where: "x" }, cpu: { mean: 80, where: "y" } })).split("\n");
  assert.match(both[both.findIndex((l) => l.startsWith("Memory pressure"))! + 1]!, /^CPU pressure: high/);
});

// `timed()` in src/burndown.ts and the landing gates' line in src/gates.ts need Docker to run, so the call sites are held by their text.
test("the timings lines of the run's steps, a landing's gates and the base gates carry the pass's CPU figures", async () => {
  const { readFileSync } = await import("node:fs");
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(burndown, /cpu = cpuOf\(result\);/);
  assert.match(burndown, /\.\.\.cpuFields\(cpu\),\n\s+\.\.\.pressureFields\(pressure\),\n\s+\.\.\.\(red\?\.length/);
  const gates = readFileSync(new URL("../src/gates.ts", import.meta.url), "utf8");
  assert.match(gates, /const cpu = done \? cpuFields\(cpuOf\(result\)\) : \{\};/);
  assert.match(gates, /\.\.\.cpu,\n\s+\.\.\.pressure,\n\s+\.\.\.\(red\?\.length/);
  assert.match(gates, /if \(green\) return \{[^\n]*\.\.\.cpuFields\(cpuOf\(run\)\)/);
});
