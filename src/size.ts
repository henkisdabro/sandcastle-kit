// `sandcastle size`: recommends the machine pool's limits (`maxSandboxes`, `maxGates`) from the
// container runtime's VM and shows the reasoning. Read-only: it writes nothing, not even
// `config.json`; the person copies the numbers in. Every read goes through `Readers`, so a test
// hands it a fake `docker info` and a made-up host.

import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { availableParallelism, homedir, totalmem } from "node:os";
import { join } from "node:path";
import { OperatorError } from "./errors.ts";
import { poolLimit } from "./pool.ts";
import { USER_CONFIG } from "./sandbox.ts";

const GIB = 2 ** 30;

// Assumed, not measured: no run has been sampled yet. One place, so a later ticket replaces them
// with measured peaks, and printed, so the person sees what the numbers rest on.
export const HEADROOM_GIB = 2;
export const PER_SANDBOX_GIB = 1.5;
export const CPUS_PER_GATE = 6;
export const MAX_SANDBOXES = 12;

export type Runtime = "orbstack" | "docker-desktop" | "podman" | "colima" | "native";

export type Readers = {
  /** `docker info --format '{{json .}}'`, or undefined when docker fails (not installed, not running). */
  dockerInfo: () => string | undefined;
  hostMemory: () => number;
  hostCpus: () => number;
  /** Free bytes on the filesystem holding `path`, or undefined when it cannot be read. */
  freeDisk: (path: string) => number | undefined;
  /** Whether `path` exists on this host (the Docker data root is inside the VM on macOS). */
  exists: (path: string) => boolean;
  home: () => string;
  platform: NodeJS.Platform;
};

export const realReaders = (): Readers => ({
  dockerInfo: () => {
    const r = spawnSync("docker", ["info", "--format", "{{json .}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
    return r.status === 0 && r.stdout.trim() ? r.stdout : undefined;
  },
  hostMemory: totalmem,
  hostCpus: availableParallelism,
  freeDisk: (path) => {
    try {
      const s = statfsSync(path);
      return s.bavail * s.bsize;
    } catch {
      return undefined;
    }
  },
  exists: existsSync,
  home: homedir,
  platform: process.platform,
});

type Info = { NCPU?: unknown; MemTotal?: unknown; Name?: unknown; OperatingSystem?: unknown; DockerRootDir?: unknown; Platform?: { Name?: unknown }; Components?: { Name?: unknown }[] };

/**
 * Which runtime answered `docker info`, from the names it puts there; undefined when none is
 * recognised on a platform that runs containers in a VM. A Linux host with none of them runs
 * Docker natively, with no VM.
 */
export const detectRuntime = (info: Info, platform: NodeJS.Platform): Runtime | undefined => {
  const text = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
  const names = [info.OperatingSystem, info.Name, info.Platform?.Name, ...(info.Components ?? []).map((c) => c.Name)].map(text).join(" | ");
  if (names.includes("orbstack")) return "orbstack";
  if (/docker desktop|docker-desktop/.test(names)) return "docker-desktop";
  if (names.includes("colima")) return "colima";
  // Podman on Linux is native too (`podman-docker`): only a machine's VM has advice to give.
  if (names.includes("podman") && (platform !== "linux" || /podman-machine|coreos/.test(names))) return "podman";
  return platform === "linux" ? "native" : undefined;
};

const RUNTIME_NAME: Record<Runtime, string> = {
  orbstack: "OrbStack",
  "docker-desktop": "Docker Desktop",
  podman: "Podman machine",
  colima: "Colima",
  native: "native Docker (no VM)",
};

// Where each runtime's VM settings live; native Docker has none.
const WHERE: Record<Exclude<Runtime, "native">, string> = {
  orbstack: "`orb config set memory_mib <MiB>` and `orb config set cpu <N>`, applied when OrbStack restarts",
  "docker-desktop": "Settings -> Resources",
  podman: "`podman machine set --cpus <N> --memory <MiB>`, with the machine stopped",
  colima: "`colima start --cpu <N> --memory <GiB>` (stop it first: `colima stop`)",
};

const gib = (bytes: number) => `${(Math.round((bytes / GIB) * 10) / 10).toString()} GiB`;
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

export type Recommendation = { sandboxes: number; gates: number; sandboxesBy: string; gatesBy: string };

/** The recommended limits from the VM's memory (bytes) and CPUs, each with the figure that set it. */
export const recommend = (memory: number, cpus: number): Recommendation => {
  const byMemory = Math.floor((memory / GIB - HEADROOM_GIB) / PER_SANDBOX_GIB);
  const raw = Math.min(byMemory, cpus);
  const sandboxes = Math.max(1, Math.min(MAX_SANDBOXES, raw));
  const memoryNote = `floor((${gib(memory)} - ${HEADROOM_GIB} GiB) / ${PER_SANDBOX_GIB} GiB) = ${byMemory}`;
  let sandboxesBy: string;
  if (raw < 1) sandboxesBy = `at least 1 (memory allows ${byMemory}: ${memoryNote})`;
  else if (raw > MAX_SANDBOXES) sandboxesBy = `the ceiling of ${MAX_SANDBOXES} (memory allows ${byMemory}, CPUs ${cpus})`;
  else if (byMemory < cpus) sandboxesBy = `memory: ${memoryNote}; CPUs allow ${cpus}`;
  else if (byMemory > cpus) sandboxesBy = `CPUs: ${cpus}; memory allows ${byMemory} (${memoryNote})`;
  else sandboxesBy = `memory and CPUs agree: ${memoryNote}, ${cpus} CPUs`;
  const byCpus = Math.floor(cpus / CPUS_PER_GATE);
  const gates = Math.max(1, byCpus);
  const gatesBy = byCpus < 1 ? `at least 1 (floor(${cpus} CPUs / ${CPUS_PER_GATE}) = ${byCpus})` : `CPUs: floor(${cpus} / ${CPUS_PER_GATE}) = ${byCpus}`;
  return { sandboxes, gates, sandboxesBy, gatesBy };
};

const current = (pool: "sandboxes" | "gates", env: Record<string, string | undefined>, machine: Record<string, unknown>) => {
  const value = poolLimit(pool, env, machine);
  const [variable, key] = pool === "sandboxes" ? ["SANDCASTLE_MAX_SANDBOXES", "maxSandboxes"] : ["SANDCASTLE_MAX_GATES", "maxGates"];
  const source = env[variable] !== undefined ? `environment ${variable}` : machine[key] !== undefined ? "config.json" : "default";
  return { value, source };
};

/** The command's output, one line each. Throws an OperatorError when the runtime cannot be asked. */
export const sizeLines = (readers: Readers, env: Record<string, string | undefined>, machine: Record<string, unknown>): string[] => {
  const raw = readers.dockerInfo();
  if (raw === undefined) {
    throw new OperatorError("Cannot read the container runtime's size: `docker info` failed. Start your runtime (`open -a OrbStack`, `open -a Docker`, `podman machine start` or `sudo systemctl start docker`), then run `sandcastle size` again.");
  }
  let info: Info;
  try {
    info = JSON.parse(raw) as Info;
  } catch {
    throw new OperatorError("`docker info --format '{{json .}}'` did not print JSON, so the runtime's size is unknown. Update the runtime, or check that `docker` is the one you mean.");
  }
  const cpus = Number(info.NCPU);
  const memory = Number(info.MemTotal);
  if (!(cpus >= 1) || !(memory > 0)) throw new OperatorError("`docker info` reports no CPU count or memory (NCPU, MemTotal), so the runtime's size is unknown.");

  const runtime = detectRuntime(info, readers.platform);
  const hostMemory = readers.hostMemory();
  const hostCpus = readers.hostCpus();
  const root = typeof info.DockerRootDir === "string" ? info.DockerRootDir : undefined;
  const diskPath = root && readers.exists(root) ? root : readers.home();
  const free = readers.freeDisk(diskPath);

  const lines = [
    `Runtime: ${runtime ? RUNTIME_NAME[runtime] : "not recognised (it is not OrbStack, Docker Desktop, Podman, Colima or native Linux Docker)"}`,
    `${runtime === "native" ? "Docker (the host's own)" : "VM"}: ${cpus} CPUs, ${gib(memory)} memory`,
    `Host: ${hostCpus} CPUs, ${gib(hostMemory)} RAM`,
    free === undefined ? `Free disk for images and worktrees: unknown (${diskPath})` : `Free disk for images and worktrees: ${gib(free)} (${diskPath})`,
    "",
    `Assumed, not measured (no run has been sampled yet): ${HEADROOM_GIB} GiB headroom, ${PER_SANDBOX_GIB} GiB per sandbox, ${CPUS_PER_GATE} CPUs per gate, at most ${MAX_SANDBOXES} sandboxes.`,
    "",
  ];

  const rec = recommend(memory, cpus);
  const now = { sandboxes: current("sandboxes", env, machine), gates: current("gates", env, machine) };
  const row = (name: string, key: "sandboxes" | "gates", by: string) => {
    const c = now[key];
    return [
      `  ${name}: ${rec[key]}  (${by})`,
      `    now ${c.value} (${c.source}) - ${c.value === rec[key] ? "already matches" : `differs; set "${name}": ${rec[key]} in ${join(USER_CONFIG, "config.json")}`}`,
    ];
  };
  lines.push("Recommended pool limits:", ...row("maxSandboxes", "sandboxes", rec.sandboxesBy), ...row("maxGates", "gates", rec.gatesBy));
  if (now.sandboxes.source.startsWith("environment") || now.gates.source.startsWith("environment")) {
    lines.push("  An environment variable overrides config.json, so change or unset it too.");
  }
  lines.push("", "This command changed nothing: copy the numbers in yourself.", "");

  if (runtime === "native") {
    lines.push("Runtime settings: native Docker has no VM to size; only the pool limits above apply.");
    return lines;
  }
  const memoryHigh = memory > hostMemory / 2;
  const cpusAll = cpus >= hostCpus;
  if (!memoryHigh && !cpusAll) {
    lines.push("Runtime settings: the VM's memory and CPUs look fine against the host's.");
    return lines;
  }
  lines.push("Runtime settings:");
  if (memoryHigh) lines.push(`  - The VM has ${gib(memory)}, more than half of the host's ${gib(hostMemory)}. Leave the host enough RAM for your other apps. Memory the containers do not use only grows the VM's file cache, which the host then swaps. About ${gib((HEADROOM_GIB + rec.sandboxes * PER_SANDBOX_GIB) * GIB)} covers ${rec.sandboxes} sandboxes.`);
  if (cpusAll) lines.push(`  - The VM has all ${cpus} of the host's CPUs. Leave the host some cores for your other apps; too few CPUs slow gates and can flake timing-sensitive tests, and 2 gates want about 8 CPUs.`);
  lines.push(runtime ? `  Where: ${WHERE[runtime]}.` : "  Where: in your runtime's own settings (OrbStack: `orb config set`; Docker Desktop: Settings -> Resources; Podman: `podman machine set`; Colima: `colima start --cpu --memory`).");
  lines.push("  Warning: applying a runtime change restarts it and stops a live run's containers. Wait for runs to finish (`sandcastle wait`).");
  return lines;
};
