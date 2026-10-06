// `sandcastle size` (src/size.ts) recommends the pool's limits from the runtime's VM. The readers are
// fakes (a `docker info` made up per test, a made-up host), so no Docker, model call or network is
// needed; the spawned tests put a fake `docker` script on PATH. The runtime detection and the
// native-Linux case are checked for both platforms by passing `platform`, not by running on each.
//
//   node --test test/size.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const config = mkdtempSync(join(tmpdir(), "sandcastle-size-cfg-"));
process.env.XDG_CONFIG_HOME = config;
process.env.HOME = config;
const { OperatorError } = await import("../src/errors.ts");
const { detectRuntime, poolWarnings, recommend, sizeLines, sizePointer } = await import("../src/size.ts");
type Readers = Parameters<typeof sizeLines>[0];

const GIB = 2 ** 30;
const reading = (info: object | undefined, over: Partial<Readers> = {}): Readers => ({
  dockerInfo: () => (info === undefined ? undefined : JSON.stringify(info)),
  hostMemory: () => 32 * GIB,
  hostCpus: () => 16,
  freeDisk: () => 120 * GIB,
  exists: () => false,
  home: () => "/home/user",
  platform: "darwin",
  ...over,
});
const orbstack = (cpus: number, gib: number) => ({ NCPU: cpus, MemTotal: gib * GIB, OperatingSystem: "OrbStack", Name: "orbstack" });
const text = (lines: string[]) => lines.join("\n");

test("8 CPUs and 8 GiB: 4 sandboxes set by memory, 1 gate set by CPUs, each figure named", () => {
  const out = text(sizeLines(reading(orbstack(8, 8)), {}, {}));
  assert.match(out, /Runtime: OrbStack/);
  assert.match(out, /maxSandboxes: 4 {2}\(memory: floor\(\(8 GiB - 2 GiB\) \/ 1\.5 GiB\) = 4; CPUs allow 8\)/);
  assert.match(recommend(8 * GIB, 8).sandboxesBy, /^memory:/);
  assert.equal(recommend(8 * GIB, 8).sandboxes, 4);
  assert.match(out, /maxGates: 1 {2}\(CPUs: floor\(8 \/ 6\) = 1\)/);
  assert.match(out, /2 GiB headroom, 1\.5 GiB per sandbox/, "the assumed figures are printed");
  assert.match(out, /Free disk for images and worktrees: 120 GiB \(\/home\/user\)/);
});

test("the smaller of memory and CPUs sets the sandboxes, within 1 and 12", () => {
  assert.deepEqual([recommend(64 * GIB, 4).sandboxes, recommend(64 * GIB, 4).sandboxesBy.startsWith("CPUs:")], [4, true]);
  assert.equal(recommend(64 * GIB, 64).sandboxes, 12);
  assert.match(recommend(64 * GIB, 64).sandboxesBy, /ceiling of 12/);
  const tiny = recommend(2 * GIB, 2);
  assert.equal(tiny.sandboxes, 1);
  assert.match(tiny.sandboxesBy, /at least 1/);
  assert.equal(recommend(64 * GIB, 24).gates, 4);
  assert.equal(recommend(64 * GIB, 3).gates, 1);
  assert.match(recommend(64 * GIB, 3).gatesBy, /at least 1/);
});

test("the current limits are shown beside it with their source, and say when they match", () => {
  const rec = recommend(8 * GIB, 8);
  const differs = text(sizeLines(reading(orbstack(8, 8)), {}, {}));
  assert.match(differs, /now 6 \(default\) - differs; set "maxSandboxes": 4/);
  assert.match(differs, /now 2 \(default\) - differs; set "maxGates": 1/);
  // The settings file this machine reads, which XDG_CONFIG_HOME moves, not a fixed ~/.config.
  assert.ok(differs.includes(`in ${join(config, "sandcastle-kit", "config.json")}`), differs);
  const matches = text(sizeLines(reading(orbstack(8, 8)), {}, { maxSandboxes: rec.sandboxes, maxGates: rec.gates }));
  assert.match(matches, /now 4 \(config\.json\) - already matches/);
  assert.match(matches, /now 1 \(config\.json\) - already matches/);
  const env = text(sizeLines(reading(orbstack(8, 8)), { SANDCASTLE_MAX_GATES: "1" }, {}));
  assert.match(env, /now 1 \(environment SANDCASTLE_MAX_GATES\) - already matches/);
  assert.match(env, /environment variable overrides config\.json/);
});

test("VM advice only when the VM's memory is over half the host's RAM, or its CPUs are all the host's", () => {
  const fine = text(sizeLines(reading(orbstack(8, 8)), {}, {}));
  assert.match(fine, /look fine/);
  assert.ok(!fine.includes("Warning:"));

  const memory = text(sizeLines(reading(orbstack(8, 20)), {}, {}));
  assert.match(memory, /more than half of the host's 32 GiB/);
  assert.match(memory, /file cache/);
  assert.match(memory, /orb config set memory_mib/);
  assert.match(memory, /restarts it and stops a live run's containers/);
  assert.ok(!memory.includes("all 8 of the host's CPUs"));

  const cpus = text(sizeLines(reading(orbstack(16, 8)), {}, {}));
  assert.match(cpus, /all 16 of the host's CPUs/);
  assert.match(cpus, /2 gates want about 8 CPUs/);

  const exactlyHalf = text(sizeLines(reading(orbstack(8, 16)), {}, {}));
  assert.match(exactlyHalf, /look fine/, "half is not more than half");
});

test("each runtime is told where its setting lives", () => {
  const where = (os: string, name: string, platform: NodeJS.Platform = "darwin") =>
    text(sizeLines(reading({ NCPU: 16, MemTotal: 8 * GIB, OperatingSystem: os, Name: name }, { platform }), {}, {}));
  assert.match(where("Docker Desktop", "docker-desktop"), /Docker Desktop\n[^]*Settings -> Resources/);
  assert.match(where("Fedora CoreOS 40", "podman-machine-default"), /Podman machine\n[^]*podman machine set --cpus <N> --memory <MiB>.*stopped/);
  assert.match(where("Ubuntu 24.04", "colima"), /Colima\n[^]*colima start --cpu <N> --memory <GiB>/);
});

test("a runtime it cannot detect still gets numbers, and advice that names every runtime's setting", () => {
  const out = text(sizeLines(reading({ NCPU: 16, MemTotal: 8 * GIB, OperatingSystem: "Something Else", Name: "vm" }), {}, {}));
  assert.match(out, /Runtime: not recognised/);
  assert.match(out, /maxSandboxes: 4/);
  assert.match(out, /orb config set`; Docker Desktop: Settings -> Resources; Podman: `podman machine set`; Colima/);
});

test("native Linux Docker has no VM advice, only the pool limits", () => {
  const info = { NCPU: 16, MemTotal: 30 * GIB, OperatingSystem: "Ubuntu 24.04 LTS", Name: "buildbox" };
  assert.equal(detectRuntime(info, "linux"), "native");
  assert.equal(detectRuntime(info, "darwin"), undefined);
  const out = text(sizeLines(reading(info, { platform: "linux", hostMemory: () => 31 * GIB, hostCpus: () => 16 }), {}, {}));
  assert.match(out, /native Docker \(no VM\)/);
  assert.match(out, /native Docker has no VM to size; only the pool limits above apply/);
  assert.ok(!out.includes("Warning:") && !out.includes("orb config"), "no VM advice though the 'VM' is all of the host");
  assert.match(out, /maxSandboxes:/);
  // Podman installed natively on Linux (podman-docker) is native, a Podman machine is not.
  assert.equal(detectRuntime({ Name: "buildbox", Components: [{ Name: "Podman Engine" }] }, "linux"), "native");
  assert.equal(detectRuntime({ Name: "podman-machine-default" }, "linux"), "podman");
});

test("the free disk is read where the Docker data root is on this host, else the home directory", () => {
  const asked: string[] = [];
  const probe = { freeDisk: (p: string) => (asked.push(p), 5 * GIB) };
  const info = { ...orbstack(8, 8), DockerRootDir: "/var/lib/docker" };
  sizeLines(reading(info, { ...probe, exists: () => true }), {}, {});
  sizeLines(reading(info, { ...probe, exists: () => false }), {}, {});
  assert.deepEqual(asked, ["/var/lib/docker", "/home/user"]);
  assert.match(text(sizeLines(reading(orbstack(8, 8), { freeDisk: () => undefined }), {}, {})), /Free disk for images and worktrees: unknown/);
});

test("a docker info that fails is an OperatorError telling the person to start the runtime", () => {
  assert.throws(() => sizeLines(reading(undefined), {}, {}), (e: Error) => e instanceof OperatorError && /Start your runtime/.test(e.message) && /docker info/.test(e.message));
  assert.throws(() => sizeLines({ ...reading({}), dockerInfo: () => "not json" }, {}, {}), /did not print JSON/);
  assert.throws(() => sizeLines(reading({ Name: "x" }), {}, {}), /NCPU, MemTotal/);
});

// ---- pricing: maxGates sandboxes at the gate figure, the rest at the agent baseline ----
// Every expected number below is worked by hand from the figures in the test, with the 10% margin
// and the 2 GiB headroom: a MiB figure x 1.1, rounded up, over 1024.

const NOW = Date.parse("2026-05-10T00:00:00Z");
type Figures = { peakMib: number; anonMib?: number; agentMib?: number; agentAnonMib?: number };
// `sampled: 2` is the mark of a line whose anon figures were read only while a phase ran (src/peaks.ts); size counts no anon figure without it.
const ran = (f: Figures) => [{ ts: "2026-05-09T00:00:00.000Z", project: "abc123", run: "r1", sampled: 2, ...f }];
const measuredOn = (cpus: number, gib: number, f: Figures | undefined, over: Partial<Readers> = {}) =>
  reading(orbstack(cpus, gib), { peaks: () => (f ? ran(f) : []), now: () => NOW, projectId: () => "abc123", ...over });

test("with no run measured, size prices every sandbox at the assumed figure, as before", () => {
  const rec = recommend(8 * GIB, 8, [], NOW);
  assert.deepEqual([rec.sandboxes, rec.gates, rec.gateGib, rec.baselineGib, rec.gateFrom, rec.baselineFrom], [4, 1, 1.5, 1.5, "assumed", "assumed"]);
  const out = text(sizeLines(measuredOn(8, 8, undefined), {}, {}));
  assert.match(out, /no run has been sampled yet\): 2 GiB headroom, 1\.5 GiB per sandbox/);
  assert.match(out, /maxSandboxes: 4 {2}\(memory: floor\(\(8 GiB - 2 GiB\) \/ 1\.5 GiB\) = 4; CPUs allow 8\)/);
  assert.deepEqual(poolWarnings(measuredOn(8, 8, undefined), {}, {}), []);
});

test("memory.peak alone prices the agent baseline at the gate figure, says so, and warns nothing", () => {
  // Gate 2000 MiB -> 2200 MiB = 2.15 GiB; floor(10 GiB / 2.15 GiB) = 4.
  const readers = measuredOn(8, 12, { peakMib: 2000 });
  const out = text(sizeLines(readers, {}, {}));
  assert.match(out, /Gate figure: 1\.95 GiB, cgroup `memory\.peak`, which includes page cache[^\n]*plus 10% is 2\.15 GiB\./);
  assert.match(out, /Agent baseline: no agent baseline measured yet, priced at the gate figure \(2\.15 GiB\)\./);
  assert.match(out, /Measured: the last 1 measured run of this project/);
  assert.match(out, /maxSandboxes: 4 {2}\(memory: floor\(\(12 GiB - 2 GiB\) \/ 2\.15 GiB\) = 4; CPUs allow 8\)/);
  assert.match(out, /maxGates: 1 {2}\(CPUs: floor\(8 \/ 6\) = 1\)/);
  // A pool far above it still draws no warning: the figure counts page cache.
  assert.deepEqual(poolWarnings(readers, {}, { maxSandboxes: 12, maxGates: 4 }), []);
  assert.match(sizePointer({}, {}) ?? "", /run `sandcastle size`/, "doctor keeps its info line while the limits are the defaults");
});

test("memory.peak with an agent baseline prices the gates and the rest apart, naming every figure", () => {
  // Gate 4000 -> 4400 MiB = 4.3 GiB; agent 1000 -> 1100 MiB = 1.07 GiB; 14 GiB usable.
  // Gates: min(floor(12 / 6) = 2, floor(14 / 4.3) = 3) = 2; then floor((14 - 8.59) / 1.07) = 5 more: 7.
  const rec = recommend(16 * GIB, 12, ran({ peakMib: 4000, agentMib: 1000 }), NOW);
  assert.deepEqual([rec.gates, rec.sandboxes, rec.gateFrom, rec.baselineFrom], [2, 7, "peak", "agent-peak"]);
  const out = text(sizeLines(measuredOn(12, 16, { peakMib: 4000, agentMib: 1000 }), {}, {}));
  assert.match(out, /Gate figure: 3\.91 GiB, cgroup `memory\.peak`[^\n]*plus 10% is 4\.3 GiB\./);
  assert.match(out, /Agent baseline: 0\.98 GiB, `memory\.peak` read before the first gate pass; plus 10% is 1\.07 GiB\./);
  assert.match(out, /maxSandboxes: 7 {2}\(memory: 2 gates at 4\.3 GiB \+ floor\(\(16 GiB - 2 GiB - 2 x 4\.3 GiB\) \/ 1\.07 GiB\) at 1\.07 GiB = 7; CPUs allow 12\)/);
  assert.match(out, /maxGates: 2 {2}\(CPUs: floor\(12 \/ 6\) = 2\)/);
  assert.match(out, /fits 7 sandboxes, so maxSandboxes is 7 and maxGates 2\./);
  assert.deepEqual(poolWarnings(measuredOn(12, 16, { peakMib: 4000, agentMib: 1000 }), {}, { maxSandboxes: 12, maxGates: 4 }), [], "no anon figure, no warning");
});

test("anon figures on a 13.7 GiB, 12-CPU VM recommend 2 gates and at least 4 sandboxes, and warn only for a pool they do not fit", () => {
  // Gate anon 2560 MiB -> 2816 MiB = 2.75 GiB; agent anon 820 -> 902 MiB = 0.88 GiB; 11.7 GiB usable.
  // The cache-inclusive figures (5.6 GiB peak, 3000 MiB agent peak) are not what is priced.
  const f = { peakMib: 5734, anonMib: 2560, agentMib: 3000, agentAnonMib: 820 };
  const rec = recommend(13.7 * GIB, 12, ran(f), NOW);
  assert.deepEqual([rec.gates, rec.gateFrom, rec.baselineFrom], [2, "anon", "agent-anon"]);
  assert.ok(rec.sandboxes >= 4, `sandboxes ${rec.sandboxes}`);
  assert.equal(rec.sandboxes, 9, "2 gates + floor((11.7 - 5.5) / 0.88) = 7 more");
  const out = text(sizeLines(measuredOn(12, 13.7, f), {}, {}));
  assert.match(out, /Gate figure: 2\.5 GiB, the anonymous memory \(no page cache\) read during gates; plus 10% is 2\.75 GiB\./);
  assert.match(out, /Agent baseline: 0\.8 GiB, the anonymous memory read during agent passes; plus 10% is 0\.88 GiB\./);
  const readers = measuredOn(12, 13.7, f);
  assert.deepEqual(poolWarnings(readers, {}, {}), [], "the default 6 and 2: 5.5 + 4 x 0.88 GiB fits");
  assert.deepEqual(poolWarnings(readers, {}, { maxSandboxes: 9, maxGates: 2 }), [], "the recommendation itself fits");
  assert.deepEqual(poolWarnings(readers, {}, { maxSandboxes: 4, maxGates: 4 }), [], "4 gates x 2.75 GiB = 11 GiB fits");
  const [over] = poolWarnings(readers, {}, { maxSandboxes: 12, maxGates: 2 });
  assert.match(over, /^maxSandboxes 12 \(config\.json\) with maxGates 2 \(config\.json\) needs about 14\.31 GiB \(2 gates x 2\.75 GiB \+ 10 x 0\.88 GiB\), above the 11\.7 GiB/);
  assert.match(over, /set "maxSandboxes": 9 in /);
  const [gates] = poolWarnings(readers, {}, { maxSandboxes: 6, maxGates: 4 });
  assert.match(gates, /set "maxGates": 2 in /);
  assert.ok(!gates.includes(`"maxSandboxes"`), gates);
});

test("memory that fits one gate gives 1 gate, never more than the sandboxes", () => {
  // 4 GiB usable: floor(4 / 2.75) = 1 gate though 12 CPUs allow 2; then floor((4 - 2.75) / 0.88) = 1 more.
  const rec = recommend(6 * GIB, 12, ran({ peakMib: 5734, anonMib: 2560, agentAnonMib: 820 }), NOW);
  assert.deepEqual([rec.gates, rec.sandboxes], [1, 2]);
  assert.equal(rec.gatesBy, "memory: floor((6 GiB - 2 GiB) / 2.75 GiB) = 1; CPUs allow 2");
  // The ceiling of 12 sandboxes holds the gates too: 96 CPUs alone would allow 16.
  const big = recommend(256 * GIB, 96, [], NOW);
  assert.deepEqual([big.sandboxes, big.gates], [12, 12]);
  assert.match(big.gatesBy, /^the sandboxes: a gate runs inside one, so at most 12/);
});

test("a VM smaller than one gate figure still gets 1 sandbox and 1 gate, at least", () => {
  // 2 GiB usable, under the 2.75 GiB gate figure.
  const rec = recommend(4 * GIB, 12, ran({ peakMib: 5734, anonMib: 2560, agentAnonMib: 820 }), NOW);
  assert.deepEqual([rec.sandboxes, rec.gates], [1, 1]);
  assert.match(rec.sandboxesBy, /^at least 1 /);
  assert.match(rec.gatesBy, /^at least 1 /);
});

test("a pool at the recommendation that still does not fit is told to grow the VM, not to set what it already has", () => {
  // 2 GiB usable, under the 2.75 GiB gate figure: 1 and 1 is the recommendation and still too much.
  const small = measuredOn(12, 4, { peakMib: 5734, anonMib: 2560, agentAnonMib: 820 });
  const [one] = poolWarnings(small, {}, { maxSandboxes: 1, maxGates: 1 });
  assert.match(one, /needs about 2\.75 GiB \(1 gate x 2\.75 GiB \+ 0 x 0\.88 GiB\), above the 2 GiB/);
  assert.match(one, /neither limit is above it, so give the VM more memory\./);
  assert.ok(!one.includes("set \""), one);
  // A cache-inclusive agent baseline (3500 -> 3850 MiB = 3.76 GiB) heavier than the anon gate (1000 -> 1100 MiB = 1.07 GiB):
  // 7.8 GiB usable recommends 2 gates + floor((7.8 - 2.15) / 3.76) = 3 sandboxes, and 3 with 1 gate needs 8.59 GiB.
  const heavy = measuredOn(12, 9.8, { peakMib: 4000, anonMib: 1000, agentMib: 3500 });
  const [three] = poolWarnings(heavy, {}, { maxSandboxes: 3, maxGates: 1 });
  assert.match(three, /recommends maxSandboxes 3 and maxGates 2/);
  assert.match(three, /neither limit is above it, so lower maxSandboxes further or give the VM more memory\./);
});

test("a VM that fits one sandbox says \"1 sandbox\", not \"1 sandboxes\"", () => {
  // 3 GiB usable: 1 gate at 2.75 GiB, and floor(0.25 / 0.88) = 0 more.
  const f = { peakMib: 5734, anonMib: 2560, agentAnonMib: 820 };
  const out = text(sizeLines(measuredOn(12, 5, f, { hostMemory: () => 8 * GIB }), {}, {}));
  assert.match(out, /fits 1 sandbox, so maxSandboxes is 1 and maxGates 1\./);
  assert.match(out, /covers 1 sandbox\./);
  assert.ok(!out.includes("1 sandboxes"), out);
});

// The spawned command, with a fake `docker` first on PATH.
const fakeDocker = (script: string) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-size-bin-"));
  writeFileSync(join(dir, "docker"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
};
const size = (bin: string, args: string[] = ["size"]) =>
  runKit(args, {
    cwd: mkdtempSync(join(tmpdir(), "sandcastle-size-cwd-")),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: config, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-size-cache-")), PATH: `${bin}${delimiter}${process.env.PATH}`, GIT_CEILING_DIRECTORIES: tmpdir() },
  });

test("sandcastle size from outside a repository prints the recommendation and writes no file", () => {
  const info = JSON.stringify(orbstack(8, 8));
  const r = size(fakeDocker(`echo '${info}'`));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /maxSandboxes: 4/);
  assert.match(r.stdout, /maxGates: 1/);
  assert.deepEqual(readdirSync(config), [], "neither config.json nor anything else was written to the machine settings directory");
});

test("sandcastle size with a failing docker exits 1 with the message and no stack", () => {
  const r = size(fakeDocker("exit 1"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Start your runtime/);
  assert.ok(!r.stderr.includes("    at "), "no stack trace");
  assert.deepEqual(readdirSync(config), []);
});

test("sandcastle help size and size --help print its entry", () => {
  const bin = fakeDocker("exit 1");
  for (const args of [["size", "--help"], ["size", "-h"]]) {
    const r = size(bin, args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}size /m);
    assert.match(r.stdout, /read-only/);
    assert.ok(!r.stdout.includes("setup  "), "only the command's own entry");
    for (const line of r.stdout.split("\n")) assert.ok(line.length <= 90, `fits the terminal: ${line}`);
  }
  for (const args of [["help"], ["help", "size"]]) {
    const listed = size(bin, args);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^ {2}size /m);
  }
  assert.equal(size(bin, ["size", "extra"]).status, 1);
});
