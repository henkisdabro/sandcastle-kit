// `sandcastle size` (src/size.ts) recommends the pool's limits from the runtime's VM. The readers are
// fakes (a `docker info` made up per test, a made-up host), so no Docker, model call or network is
// needed; the spawned tests put a fake `docker` script on PATH. The runtime detection and the
// native-Linux case are checked for both platforms by passing `platform`, not by running on each.
//
//   pnpm exec tsx --test test/size.test.ts

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
const { detectRuntime, recommend, sizeLines } = await import("../src/size.ts");
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
