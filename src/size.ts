// `sandcastle size`: recommends the machine pool's limits (`maxSandboxes`, `maxGates`) from the
// container runtime's VM and shows the reasoning. Read-only: it writes nothing, not even
// `config.json`; the person copies the numbers in. Every read goes through `Readers`, so a test
// hands it a fake `docker info` and a made-up host.

import { spawnSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { availableParallelism, homedir, totalmem } from "node:os";
import { join } from "node:path";
import { OperatorError } from "./errors.ts";
import { type PeakLine, projectId, readPeaks } from "./peaks.ts";
import { poolLimit } from "./pool.ts";
import { readDockerInfo } from "./runtime.ts";
import { machineSettings, USER_CONFIG } from "./sandbox.ts";

const GIB = 2 ** 30;

// Assumed, not measured, and printed so the person sees what the numbers rest on. The per-sandbox
// figure is only the fallback: once runs have recorded sandbox peaks (src/peaks.ts) those are used.
// On native Linux Docker the "VM" is the whole host (`MemTotal` is the host's RAM), so the headroom
// covers less there: the desktop and everything else on the machine share it.
export const HEADROOM_GIB = 2;
export const PER_SANDBOX_GIB = 1.5;
// A measured peak is a project's highest over its last RECENT_RUNS measured runs, so one runaway
// run drops out after a few more; only a project measured within FRESH_DAYS counts, so a project
// no longer worked on does not set the limit; and MARGIN covers a run a little heavier than any seen.
export const RECENT_RUNS = 5;
export const FRESH_DAYS = 30;
export const MARGIN = 1.1;
export const CPUS_PER_GATE = 6;
export const MAX_SANDBOXES = 12;

export type Runtime = "orbstack" | "docker-desktop" | "podman" | "colima" | "native";

export type Readers = {
  /** `docker info --format '{{json .}}'`, or undefined when docker fails (not installed, not running); throws an `OperatorError` when docker does not answer in time (`readDockerInfo`). */
  dockerInfo: () => string | undefined;
  hostMemory: () => number;
  hostCpus: () => number;
  /** Free bytes on the filesystem holding `path`, or undefined when it cannot be read. */
  freeDisk: (path: string) => number | undefined;
  /** Whether `path` exists on this host (the Docker data root is inside the VM on macOS). */
  exists: (path: string) => boolean;
  home: () => string;
  platform: NodeJS.Platform;
  /** The machine-wide sandbox peaks; none when omitted. */
  peaks?: () => PeakLine[];
  /** The id of the project the command runs in, which marks it among the peaks; none when omitted or outside a project. */
  projectId?: () => string | undefined;
  /** The clock in ms; `Date.now` when omitted. */
  now?: () => number;
};

export const realReaders = (): Readers => ({
  dockerInfo: readDockerInfo,
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
  peaks: () => readPeaks(),
  projectId: () => {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 && r.stdout.trim() ? projectId(r.stdout.trim()) : undefined;
  },
  now: Date.now,
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
  // Podman is a runtime only on macOS, where it runs a machine (untested); on Linux doctor and run
  // refuse it for now (#359, src/runtime.ts), and a Linux name without a machine's is native.
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

/**
 * What the peaks say: the heaviest project's highest figures over its runs, the project and the runs
 * they rest on. `peakMib` is the whole-life `memory.peak`, `anonMib` the anonymous memory read while a
 * gate ran, `agentMib` the `memory.peak` read before the first gate and `agentAnonMib` the anonymous
 * memory read while an agent pass ran; each optional one is absent when no run recorded it.
 */
export type Measured = { peakMib: number; project: string; runs: number; anonMib?: number; agentMib?: number; agentAnonMib?: number };

/**
 * The heaviest project's figures: each project's highest over its last `RECENT_RUNS` measured runs
 * (a run is the peaks sharing a `run`, as old as its newest line), then the project with the
 * highest `peakMib` of those whose newest measured run is within `FRESH_DAYS` of `now`. Undefined
 * with nothing measured, in which case the caller keeps the assumed figure.
 */
export const measuredPeak = (peaks: PeakLine[], now: number): Measured | undefined => {
  type RunPeak = { at: number; peakMib: number; anonMib: number; agentMib: number; agentAnonMib: number };
  const byProject = new Map<string, Map<string, RunPeak>>();
  for (const l of peaks) {
    const runs = byProject.get(l.project) ?? new Map<string, RunPeak>();
    const run = runs.get(l.run) ?? { at: 0, peakMib: 0, anonMib: 0, agentMib: 0, agentAnonMib: 0 };
    runs.set(l.run, {
      at: Math.max(run.at, Date.parse(l.ts)),
      peakMib: Math.max(run.peakMib, l.peakMib),
      anonMib: Math.max(run.anonMib, l.anonMib ?? 0),
      agentMib: Math.max(run.agentMib, l.agentMib ?? 0),
      agentAnonMib: Math.max(run.agentAnonMib, l.agentAnonMib ?? 0),
    });
    byProject.set(l.project, runs);
  }
  let best: (Measured & { at: number }) | undefined;
  for (const [project, runs] of byProject) {
    const recent = [...runs.values()].sort((a, b) => b.at - a.at).slice(0, RECENT_RUNS);
    if (!recent.length || recent[0].at < now - FRESH_DAYS * 86_400_000) continue;
    const peakMib = Math.max(...recent.map((r) => r.peakMib));
    if (!best || peakMib > best.peakMib || (peakMib === best.peakMib && recent[0].at > best.at)) {
      const most = (k: "anonMib" | "agentMib" | "agentAnonMib") => {
        const v = Math.max(...recent.map((r) => r[k]));
        return v > 0 ? { [k]: v } : {};
      };
      best = { peakMib, project, runs: recent.length, ...most("anonMib"), ...most("agentMib"), ...most("agentAnonMib"), at: recent[0].at };
    }
  }
  if (!best) return undefined;
  const { at: _at, ...measured } = best;
  return measured;
};

/** Where a priced figure came from: the gate's and the agent baseline's sources, or the assumed one. */
export type GateSource = "anon" | "peak" | "assumed";
export type BaselineSource = "agent-anon" | "agent-peak" | "gate" | "assumed";

export type Recommendation = {
  sandboxes: number;
  gates: number;
  sandboxesBy: string;
  gatesBy: string;
  /** Memory alone allows this many sandboxes, the gates among them (the CPUs and the ceiling may lower the limit). */
  byMemory: number;
  /** What one sandbox running a gate is priced at, in GiB, the margin included. */
  gateGib: number;
  /** What one sandbox between gates is priced at, in GiB, the margin included. */
  baselineGib: number;
  gateFrom: GateSource;
  baselineFrom: BaselineSource;
  /** Set when the figures are measured. */
  measured?: Measured;
};

const gib2 = (g: number) => String(Math.round(g * 100) / 100);
const withMargin = (mib: number) => Math.ceil(mib * MARGIN - 1e-9) / 1024;

/**
 * The recommended limits from the VM's memory (bytes) and CPUs, each with the figure that set it.
 * A gate runs inside a sandbox, so `maxGates` sandboxes are priced at the gate figure and the rest at
 * the agent baseline: pricing every sandbox at a gate's peak recommends far fewer than a VM runs.
 * The anonymous figures (no page cache) are used when recorded, else `memory.peak`; with no agent
 * baseline the rest are priced at the gate figure, and with nothing measured both are `PER_SANDBOX_GIB`.
 */
export const recommend = (memory: number, cpus: number, peaks: PeakLine[] = [], now = Date.now()): Recommendation => {
  const measured = measuredPeak(peaks, now);
  let gateGib = PER_SANDBOX_GIB;
  let baselineGib = PER_SANDBOX_GIB;
  let gateFrom: GateSource = "assumed";
  let baselineFrom: BaselineSource = "assumed";
  if (measured) {
    gateFrom = measured.anonMib ? "anon" : "peak";
    gateGib = withMargin(measured.anonMib ?? measured.peakMib);
    // An anon gate beside a cache-inclusive baseline would still be priced, but never the reverse: the
    // agent's anon figure only counts once the gate's is anon too, so both rest on the same measure.
    if (gateFrom === "anon" && measured.agentAnonMib) [baselineFrom, baselineGib] = ["agent-anon", withMargin(measured.agentAnonMib)];
    else if (measured.agentMib) [baselineFrom, baselineGib] = ["agent-peak", withMargin(measured.agentMib)];
    else [baselineFrom, baselineGib] = ["gate", gateGib];
  }
  const usable = memory / GIB - HEADROOM_GIB;
  const gatesByCpus = Math.floor(cpus / CPUS_PER_GATE);
  const gatesByMemory = Math.floor(usable / gateGib);
  const g = Math.max(1, Math.min(gatesByCpus, gatesByMemory));
  const byMemory = g + Math.floor((usable - g * gateGib) / baselineGib);
  const raw = Math.min(byMemory, cpus);
  const sandboxes = Math.max(1, Math.min(MAX_SANDBOXES, raw));
  const gates = Math.min(g, sandboxes);
  // With one figure for every sandbox, g + floor((usable - g x f) / f) is floor(usable / f): say it that way.
  const memoryNote =
    gateGib === baselineGib
      ? `floor((${gib(memory)} - ${HEADROOM_GIB} GiB) / ${gib2(gateGib)} GiB) = ${byMemory}`
      : `${g} gate${g === 1 ? "" : "s"} at ${gib2(gateGib)} GiB + floor((${gib(memory)} - ${HEADROOM_GIB} GiB - ${g} x ${gib2(gateGib)} GiB) / ${gib2(baselineGib)} GiB) at ${gib2(baselineGib)} GiB = ${byMemory}`;
  let sandboxesBy: string;
  if (raw < 1) sandboxesBy = `at least 1 (memory allows ${byMemory}: ${memoryNote})`;
  else if (raw > MAX_SANDBOXES) sandboxesBy = `the ceiling of ${MAX_SANDBOXES} (memory allows ${byMemory}, CPUs ${cpus})`;
  else if (byMemory < cpus) sandboxesBy = `memory: ${memoryNote}; CPUs allow ${cpus}`;
  else if (byMemory > cpus) sandboxesBy = `CPUs: ${cpus}; memory allows ${byMemory} (${memoryNote})`;
  else sandboxesBy = `memory and CPUs agree: ${memoryNote}, ${cpus} CPUs`;
  const cpuNote = `floor(${cpus} / ${CPUS_PER_GATE}) = ${gatesByCpus}`;
  const gateMemoryNote = `floor((${gib(memory)} - ${HEADROOM_GIB} GiB) / ${gib2(gateGib)} GiB) = ${gatesByMemory}`;
  let gatesBy: string;
  if (gates < g) gatesBy = `the sandboxes: a gate runs inside one, so at most ${sandboxes} (CPUs: ${cpuNote}; memory: ${gateMemoryNote})`;
  else if (Math.min(gatesByCpus, gatesByMemory) < 1) gatesBy = `at least 1 (CPUs: ${cpuNote}; memory: ${gateMemoryNote})`;
  else if (gatesByMemory < gatesByCpus) gatesBy = `memory: ${gateMemoryNote}; CPUs allow ${gatesByCpus}`;
  else gatesBy = `CPUs: ${cpuNote}`;
  return { sandboxes, gates, sandboxesBy, gatesBy, byMemory, gateGib, baselineGib, gateFrom, baselineFrom, ...(measured ? { measured } : {}) };
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
  ];

  const peaks = readers.peaks?.() ?? [];
  const rec = recommend(memory, cpus, peaks, readers.now?.() ?? Date.now());
  const m = rec.measured;
  if (m) {
    const where = m.project === readers.projectId?.() ? "this project" : `project ${m.project}`;
    const plus = `plus ${Math.round((MARGIN - 1) * 100)}%`;
    const gate =
      rec.gateFrom === "anon"
        ? `Gate figure: ${gib2(m.anonMib! / 1024)} GiB, the anonymous memory (no page cache) read during gates; ${plus} is ${gib2(rec.gateGib)} GiB. (Their cgroup \`memory.peak\`, page cache included, was ${gib2(m.peakMib / 1024)} GiB.)`
        : `Gate figure: ${gib2(m.peakMib / 1024)} GiB, cgroup \`memory.peak\`, which includes page cache the kernel has not yet reclaimed, so it can overstate what a sandbox needs; ${plus} is ${gib2(rec.gateGib)} GiB. No anonymous-memory (no page cache) figure was recorded during gates in those runs, so no pool warning is given until one is.`;
    const baseline =
      rec.baselineFrom === "agent-anon"
        ? `Agent baseline: ${gib2(m.agentAnonMib! / 1024)} GiB, the anonymous memory read during agent passes; ${plus} is ${gib2(rec.baselineGib)} GiB.`
        : rec.baselineFrom === "agent-peak"
          ? `Agent baseline: ${gib2(m.agentMib! / 1024)} GiB, \`memory.peak\` read before the first gate pass; ${plus} is ${gib2(rec.baselineGib)} GiB.`
          : `Agent baseline: no agent baseline measured yet, priced at the gate figure (${gib2(rec.baselineGib)} GiB).`;
    lines.push(
      `Measured: the last ${m.runs} measured run${m.runs === 1 ? "" : "s"} of ${where}, the heaviest of any project in the last ${FRESH_DAYS} days.`,
      gate,
      baseline,
      `A gate runs inside a sandbox, so maxGates sandboxes are priced at the gate figure and the rest at the agent baseline. This VM's memory fits ${rec.byMemory} sandbox${rec.byMemory === 1 ? "" : "es"}, so maxSandboxes is ${rec.sandboxes} and maxGates ${rec.gates}.`,
      `Assumed, not measured: ${HEADROOM_GIB} GiB headroom, ${CPUS_PER_GATE} CPUs per gate, at most ${MAX_SANDBOXES} sandboxes.`,
    );
  } else {
    lines.push(`Assumed, not measured (no run has been sampled yet): ${HEADROOM_GIB} GiB headroom, ${PER_SANDBOX_GIB} GiB per sandbox, ${CPUS_PER_GATE} CPUs per gate, at most ${MAX_SANDBOXES} sandboxes.`);
  }
  lines.push("");
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
  if (memoryHigh) lines.push(`  - The VM has ${gib(memory)}, more than half of the host's ${gib(hostMemory)}. Leave the host enough RAM for your other apps. Memory the containers do not use only grows the VM's file cache, which the host then swaps. About ${gib((HEADROOM_GIB + rec.gates * rec.gateGib + (rec.sandboxes - rec.gates) * rec.baselineGib) * GIB)} covers ${rec.sandboxes} sandbox${rec.sandboxes === 1 ? "" : "es"}.`);
  if (cpusAll) lines.push(`  - The VM has all ${cpus} of the host's CPUs. Leave the host some cores for your other apps; too few CPUs slow gates and can flake timing-sensitive tests, and 2 gates want about 8 CPUs.`);
  lines.push(runtime ? `  Where: ${WHERE[runtime]}.` : "  Where: in your runtime's own settings (OrbStack: `orb config set`; Docker Desktop: Settings -> Resources; Podman: `podman machine set`; Colima: `colima start --cpu --memory`).");
  lines.push("  Warning: applying a runtime change restarts it and stops a live run's containers. Wait for runs to finish (`sandcastle wait`).");
  return lines;
};

/**
 * A warning when the pool's limits, priced as `recommend` prices them (`maxGates` sandboxes at the
 * gate figure, the rest at the agent baseline), need more than the VM's memory less the headroom:
 * one line naming what they need, what the VM has, the recommendation and the key (or the
 * environment variable that overrides it) to set. Only when the gate figure is the anonymous memory
 * read during gates: `memory.peak` counts page cache, and a pool it said did not fit ran clean, so
 * until a run records anon figures doctor keeps its info pointer and the start line says nothing.
 * Nothing when the runtime cannot be asked, rather than an error: doctor and the start line have no
 * use for one.
 */
export const poolWarnings = (readers: Readers, env: Record<string, string | undefined>, machine: Record<string, unknown>): string[] => {
  const raw = readers.dockerInfo();
  if (raw === undefined) return [];
  let info: Info;
  try {
    info = JSON.parse(raw) as Info;
  } catch {
    return [];
  }
  const cpus = Number(info.NCPU);
  const memory = Number(info.MemTotal);
  if (!(cpus >= 1) || !(memory > 0)) return [];
  const rec = recommend(memory, cpus, readers.peaks?.() ?? [], readers.now?.() ?? Date.now());
  if (rec.gateFrom !== "anon") return [];
  const sandboxes = current("sandboxes", env, machine);
  const gates = current("gates", env, machine);
  // A gate runs inside a sandbox, so more gates than sandboxes never run at once.
  const g = Math.min(gates.value, sandboxes.value);
  const need = g * rec.gateGib + (sandboxes.value - g) * rec.baselineGib;
  const usable = memory / GIB - HEADROOM_GIB;
  if (need <= usable) return [];
  const limits = [
    { pool: "sandboxes", name: "maxSandboxes", variable: "SANDCASTLE_MAX_SANDBOXES", c: sandboxes },
    { pool: "gates", name: "maxGates", variable: "SANDCASTLE_MAX_GATES", c: gates },
  ] as const;
  const above = limits.filter((l) => l.c.value > rec[l.pool]);
  // Neither above its recommendation and still too much (a VM under one gate figure, a baseline heavier than
  // the gate): setting a limit to the value it already has would be advice the person cannot act on.
  const set = above.length
    ? above.map((l) => (l.c.source.startsWith("environment") ? `change or unset ${l.variable}` : `set "${l.name}": ${rec[l.pool]} in ${join(USER_CONFIG, "config.json")}`)).join(" and ")
    : `neither limit is above it, so ${sandboxes.value > 1 ? "lower maxSandboxes further or " : ""}give the VM more memory`;
  const priced = `${g} gate${g === 1 ? "" : "s"} x ${gib2(rec.gateGib)} GiB + ${sandboxes.value - g} x ${gib2(rec.baselineGib)} GiB`;
  return [
    `maxSandboxes ${sandboxes.value} (${sandboxes.source}) with maxGates ${gates.value} (${gates.source}) needs about ${gib2(need)} GiB (${priced}), above the ${gib2(usable)} GiB this VM has after ${HEADROOM_GIB} GiB headroom; \`sandcastle size\` recommends maxSandboxes ${rec.sandboxes} and maxGates ${rec.gates} from the measured anonymous memory: ${set}. More at once than the VM fits risks out-of-memory faults and slow gates.`,
  ];
};

/**
 * `poolWarnings` for this process, over `info` (the start's one `docker info` reading) when the
 * caller has one. A bad config.json or pool setting is reported elsewhere (doctor's own FIX, the
 * run's refusal): no warning here, and none when docker does not answer.
 */
export const poolWarningsNow = (info?: () => string | undefined): string[] => {
  try {
    return poolWarnings({ ...realReaders(), ...(info ? { dockerInfo: info } : {}) }, process.env, machineSettings());
  } catch {
    return [];
  }
};

/**
 * One line pointing at `sandcastle size`, while both pool limits are the untouched defaults: no
 * `maxSandboxes` or `maxGates` in config.json and no `SANDCASTLE_MAX_*` in the environment (a
 * limit set to the default's own value is still set by a person). Undefined once either is set.
 */
export const sizePointer = (env: Record<string, string | undefined>, machine: Record<string, unknown>): string | undefined => {
  const set = env.SANDCASTLE_MAX_SANDBOXES !== undefined || env.SANDCASTLE_MAX_GATES !== undefined || machine.maxSandboxes !== undefined || machine.maxGates !== undefined;
  return set ? undefined : "The machine pool's limits are the untouched defaults: run `sandcastle size` to see what this machine can take.";
};

/**
 * `sizePointer` for this process. A config.json that cannot be read is no reason to point anywhere:
 * doctor reports it as a FIX of its own, and setup's doctor says it first.
 */
export const sizePointerNow = (): string | undefined => {
  try {
    return sizePointer(process.env, machineSettings());
  } catch {
    return undefined;
  }
};
