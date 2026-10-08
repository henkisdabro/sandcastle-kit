// What `sandcastle size` may price from the peaks file (src/peaks.ts, src/size.ts): an `anon` figure counts only if it
// was read while a phase ran. The sandbox is a fake `exec` whose kernel files answer from a variable the test sets, and
// `size` is run over fake readers, so there is no Docker, model call or network. Every expected figure is worked by
// hand from the figures in the test: a MiB figure x 1.1, rounded up, over 1024.
//
//   pnpm test:file test/size-sampled-peaks.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.HOME = process.env.XDG_CONFIG_HOME;
const { readPeaks, recordPeak, sampling } = await import("../src/peaks.ts");
const { runGates } = await import("../src/gates.ts");
const { MIN_MEASURED_MIB, measuredPeak, poolWarnings, recommend, sizeLines, sizePointer } = await import("../src/size.ts");
type Readers = Parameters<typeof sizeLines>[0];

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-size-sampled-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const MIB = 2 ** 20;
const GIB = 2 ** 30;
const NOW = Date.parse("2026-05-10T00:00:00Z");

/** A sandbox's kernel files: `memory.peak` reads `peak` MiB and `memory.stat`'s `anon` reads `anon` MiB, as the test sets them. */
const kernel = () => {
  const k = { peak: 3000, anon: 700 };
  const answer = (cmd: string) => {
    if (cmd.includes("memory.peak")) return { exitCode: 0, stdout: `${k.peak * MIB}\n`, stderr: "" };
    if (cmd.includes("memory.stat")) return { exitCode: 0, stdout: `file 999999999\nanon ${k.anon * MIB}\nkernel 4096\n`, stderr: "" };
    return undefined;
  };
  return { k, answer };
};
const gateProject = () => ({ name: "made-up", root: TMP, gates: [{ name: "test", command: "run-tests" }] }) as Parameters<typeof runGates>[0];
const lineOf = async (box: Parameters<typeof recordPeak>[0]) => {
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  await recordPeak(box, TMP, "run-1", file, new Date("2026-10-05T10:00:00Z"));
  return readPeaks(file)[0];
};

test("a gate pass that ends before the first interval still records the anon read taken as it started", async () => {
  const { k, answer } = kernel();
  k.anon = 900;
  // The gate command returns at once: no 10-second reading ever happens.
  const box = { worktreePath: "/made-up", exec: async (cmd: string) => answer(cmd) ?? { exitCode: 0, stdout: "", stderr: "" } };
  const run = await runGates(gateProject(), box, "gates");
  assert.equal(run.gates[0].pass, true);
  const line = await lineOf(box);
  assert.equal(line.anonMib, 900);
  assert.equal(line.sampled, 2);
});

test("an agent pass that ends before the first interval records its first read as agentAnonMib", async () => {
  const { k, answer } = kernel();
  k.anon = 800;
  const box = { exec: async (cmd: string) => answer(cmd) ?? { exitCode: 0, stdout: "", stderr: "" } };
  await sampling(box, "agent", async () => "done");
  const line = await lineOf(box);
  assert.equal(line.agentAnonMib, 800);
  assert.ok(!("anonMib" in line), "no gate ran in it");
});

test("the read after a gate pass, when the sandbox holds more than the gate used, does not raise anonMib", async () => {
  const { k, answer } = kernel();
  k.anon = 700;
  // The sandbox's anon is 5000 MiB once the gate command has run: only a read after it would see that.
  const box = {
    worktreePath: "/made-up",
    exec: async (cmd: string) => {
      const known = answer(cmd);
      if (known) return known;
      k.anon = 5000;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await runGates(gateProject(), box, "gates");
  k.anon = 5000;
  assert.equal((await lineOf(box)).anonMib, 700);
});

test("the read after an agent pass does not raise agentAnonMib", async () => {
  const { k, answer } = kernel();
  k.anon = 800;
  const box = { exec: async (cmd: string) => answer(cmd) ?? { exitCode: 0, stdout: "", stderr: "" } };
  await sampling(box, "agent", async () => {
    k.anon = 6000;
  });
  assert.equal((await lineOf(box)).agentAnonMib, 800);
});

// ---- what size prices ----

const GATE_VM = { NCPU: 12, MemTotal: 13.7 * GIB, OperatingSystem: "OrbStack", Name: "orbstack" };
const reading = (peaks: ReturnType<typeof ran>, over: Partial<Readers> = {}, info: object = GATE_VM): Readers => ({
  dockerInfo: () => JSON.stringify(info),
  hostMemory: () => 32 * GIB,
  hostCpus: () => 16,
  freeDisk: () => 120 * GIB,
  exists: () => false,
  home: () => "/home/user",
  platform: "darwin",
  peaks: () => peaks,
  now: () => NOW,
  ...over,
});
const text = (lines: string[]) => lines.join("\n");
type Figures = { peakMib: number; anonMib?: number; agentMib?: number; agentAnonMib?: number; sampled?: number };
const ran = (f: Figures, run = "r1", ts = "2026-05-09T00:00:00.000Z") => [{ ts, project: "abc123", run, ...f }];
// A number below zero in the output: a space, a bracket or a colon before the minus (a path may hold "-1").
const NEGATIVE = /(^|[\s(:=])-\d/m;

test("a peaks file of lines written before the marker, each with anonMib 1, prices no gate from that figure", () => {
  // 22 tickets of one run, each peaking at 5177-5383 MiB beside an anon of 1 MiB (the sandbox at rest), no marker on any.
  const old = Array.from({ length: 32 }, (_, i) => ({ ts: "2026-05-09T00:00:00.000Z", project: "abc123", run: "r1", peakMib: 5177 + (i % 8) * 30, anonMib: 1, agentAnonMib: 1 }));
  const readers = reading(old);
  const out = text(sizeLines(readers, {}, {}));
  assert.ok(!out.includes("Gate figure: 0 GiB"), out);
  assert.ok(!out.includes("Agent baseline: 0 GiB"), out);
  const rec = recommend(13.7 * GIB, 12, old, NOW);
  // The highest peak is 5177 + 7 x 30 = 5387 MiB: x 1.1 = 5925.7, rounded up 5926 MiB = 5.79 GiB; 11.7 GiB usable fits 2 of them.
  assert.deepEqual([rec.gateFrom, rec.baselineFrom, rec.byMemory, rec.sandboxes, rec.gates], ["peak", "gate", 2, 2, 2]);
  assert.match(out, /Gate figure: 5\.26 GiB, cgroup `memory\.peak`[^\n]*plus 10% is 5\.79 GiB\./);
  assert.ok(rec.sandboxes <= GATE_VM.NCPU, "no more than the CPUs allow");
  // Nothing priced from anon, so no warning, and doctor keeps its info line while the limits are the defaults.
  assert.deepEqual(poolWarnings(readers, {}, { maxSandboxes: 12, maxGates: 2 }), []);
  assert.match(sizePointer({}, {}) ?? "", /run `sandcastle size`/);
});

test("a run's marked lines count their anon figures while the unmarked lines before them do not", () => {
  const peaks = [
    ...ran({ peakMib: 5300, anonMib: 1, agentAnonMib: 1 }, "old", "2026-05-08T00:00:00.000Z"),
    ...ran({ peakMib: 5200, anonMib: 2560, agentAnonMib: 820, sampled: 2 }, "new", "2026-05-09T00:00:00.000Z"),
  ];
  const m = measuredPeak(peaks, NOW);
  assert.deepEqual(m, {
    peakMib: 5300,
    project: "abc123",
    runs: 2,
    anonMib: 2560,
    agentAnonMib: 820,
    figures: { peak: { mib: 5300, samples: 2, highest: 5300 }, anon: { mib: 2560, samples: 1, highest: 2560 }, agentAnon: { mib: 820, samples: 1, highest: 820 } },
  });
  // An unmarked line's anon is not read as a larger figure than a marked one's, nor as the only one.
  assert.deepEqual(measuredPeak([{ ...peaks[0], anonMib: 9000, agentAnonMib: 3000 }, peaks[1]], NOW)?.anonMib, 2560);
});

test("a line whose sampling version is newer than this one still counts", () => {
  assert.equal(measuredPeak(ran({ peakMib: 5200, anonMib: 2560, sampled: 3 }), NOW)?.anonMib, 2560);
});

test("an anon figure under the floor is not measured: the gate is priced from memory.peak", () => {
  assert.equal(MIN_MEASURED_MIB, 256);
  const low = ran({ peakMib: 5000, anonMib: 255, sampled: 2 });
  assert.equal(measuredPeak(low, NOW)?.anonMib, undefined);
  const rec = recommend(13.7 * GIB, 12, low, NOW);
  assert.equal(rec.gateFrom, "peak");
  assert.match(text(sizeLines(reading(low), {}, {})), /Gate figure: 4\.88 GiB, cgroup `memory\.peak`/);
  // 256 MiB is the lowest that counts: x 1.1 = 281.6, rounded up 282 MiB = 0.28 GiB.
  const edge = recommend(13.7 * GIB, 12, ran({ peakMib: 5000, anonMib: 256, sampled: 2 }), NOW);
  assert.deepEqual([edge.gateFrom, edge.gateGib], ["anon", 282 / 1024]);
});

test("an agent anon figure under the floor is not measured: the baseline comes from the agent's memory.peak", () => {
  const rec = recommend(16 * GIB, 12, ran({ peakMib: 4000, anonMib: 2560, agentMib: 1000, agentAnonMib: 40, sampled: 2 }), NOW);
  assert.deepEqual([rec.gateFrom, rec.baselineFrom], ["anon", "agent-peak"]);
});

test("a project whose peak is under the floor is not measured: size keeps the assumed figures", () => {
  const peaks = ran({ peakMib: 200, anonMib: 150, sampled: 2 });
  assert.equal(measuredPeak(peaks, NOW), undefined);
  const out = text(sizeLines(reading(peaks), {}, {}));
  assert.match(out, /Assumed, not measured \(no run has been sampled yet\)/);
  assert.deepEqual([recommend(13.7 * GIB, 12, peaks, NOW).gateFrom], ["assumed"]);
});

test("a VM with less than one gate figure usable says it cannot fit a gate sandbox, with no negative number", () => {
  // Gate anon 2560 MiB -> 2816 MiB = 2.75 GiB; agent anon 820 -> 902 MiB = 0.88 GiB. A 2 GiB VM has 0 GiB usable after
  // the 2 GiB headroom: 1 gate + floor(-2.75 / 0.88) was "memory allows -3".
  const figures = ran({ peakMib: 5734, anonMib: 2560, agentAnonMib: 820, sampled: 2 });
  for (const gib of [0.5, 1, 2, 3, 4]) {
    const info = { NCPU: 12, MemTotal: gib * GIB, OperatingSystem: "OrbStack", Name: "orbstack" };
    const rec = recommend(gib * GIB, 12, figures, NOW);
    assert.deepEqual([rec.byMemory, rec.sandboxes, rec.gates], [0, 1, 1], `${gib} GiB`);
    assert.match(rec.sandboxesBy, /^at least 1 \(this VM cannot fit one gate sandbox: /, `${gib} GiB`);
    assert.match(rec.gatesBy, /^at least 1 \(CPUs: floor\(12 \/ 6\) = 2; memory: cannot fit one gate sandbox: /, `${gib} GiB`);
    const out = text(sizeLines(reading(figures, {}, info), {}, {}));
    assert.ok(!NEGATIVE.test(out), `${gib} GiB:\n${out}`);
    assert.match(out, /This VM's memory cannot fit one gate sandbox, so maxSandboxes is 1 and maxGates 1, the least a pool takes\./);
    const [warning] = poolWarnings(reading(figures, {}, info), {}, { maxSandboxes: 1, maxGates: 1 });
    assert.ok(warning, `${gib} GiB: 1 gate needs 2.75 GiB`);
    assert.ok(!NEGATIVE.test(warning), `${gib} GiB: ${warning}`);
  }
  // The same VM with the assumed figures: 1.5 GiB a sandbox does not fit 0 GiB either.
  const assumed = recommend(2 * GIB, 12, [], NOW);
  assert.deepEqual([assumed.byMemory, assumed.sandboxes], [0, 1]);
  assert.ok(!NEGATIVE.test(text(sizeLines(reading([], {}, { NCPU: 12, MemTotal: 2 * GIB, OperatingSystem: "OrbStack" }), {}, {}))));
});

test("a VM that fits one gate sandbox still says how many sandboxes memory allows", () => {
  // 6 GiB: 4 GiB usable; 1 gate at 2.75 GiB + floor(1.25 / 0.88) = 1 more.
  const rec = recommend(6 * GIB, 12, ran({ peakMib: 5734, anonMib: 2560, agentAnonMib: 820, sampled: 2 }), NOW);
  assert.deepEqual([rec.byMemory, rec.sandboxes, rec.gates], [2, 2, 1]);
  assert.match(text(sizeLines(reading(ran({ peakMib: 5734, anonMib: 2560, agentAnonMib: 820, sampled: 2 }), {}, { ...GATE_VM, MemTotal: 6 * GIB }), {}, {})), /This VM's memory fits 2 sandboxes, so maxSandboxes is 2 and maxGates 1\./);
});

test("the peaks file keeps the marker a line was written with", async () => {
  const { answer } = kernel();
  const box = { exec: async (cmd: string) => answer(cmd) ?? { exitCode: 0, stdout: "", stderr: "" } };
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  await recordPeak(box, TMP, "run-1", file);
  assert.match(readFileSync(file, "utf8"), /"sampled":2/);
  assert.equal(readPeaks(file)[0].sampled, 2);
});
