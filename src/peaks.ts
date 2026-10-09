// Each sandbox's peak memory, so `sandcastle size` recommends from what runs used rather than a
// guess. The kernel keeps the high-water mark itself (cgroup v2 `memory.peak`, in bytes), so it is
// read from inside the container after each gate pass and again before the sandbox closes: nothing
// to name or find a container by. A gate pass runs in the agent's own sandbox (base and verify
// gates in a throwaway one, a landing's gates in its landing sandbox), so the sandbox's peak covers its gates.
//
// `memory.peak` cannot be reset from inside a sandbox (`/sys/fs/cgroup` is read-only there), so what
// an agent needs between gates is read once, just before the sandbox's first gate pass, as `agentMib`.
//
// `memory.peak` counts page cache the kernel has not yet reclaimed, so it can overstate what a
// sandbox needs. `memory.stat`'s `anon` (memory no file backs) has no high-water mark: it is the
// figure at the moment of the read, so only a reading taken while a phase runs describes it - read
// after the gates, the test workers have exited, and the sandbox at rest (running only `sleep`) reads
// about 1 MiB. So `anon` is read through the sandbox's own `exec` once as a gate pass starts and every
// 10 s while it runs, kept as `anonMib`, and likewise while an agent pass runs (implement, review,
// repair, resolve), kept as `agentAnonMib`; a reading taken after a phase counts towards neither (the
// first read is what gives a pass shorter than 10 s one taken during it). Each is a lower bound.
//
// Memory pressure (PSI) rides the same loop: the sandbox's own cgroup `memory.pressure`, `some` and `full` `avg10` (the
// percent of the last 10 s that tasks stalled on memory, `full` being all of them at once), read beside the anonymous
// figure and kept as the highest. A kernel with no PSI (older, or `psi=0`) has no file and records nothing. An `avg10`
// reaches back 10 s, so a phase's first read can still carry the end of the one before it. Warn-only: `size` shows it
// and a run's report warns past `PRESSURE_WARN_FULL`; nothing prices a pool from it yet.
//
// Two records: a `peakMib` on the timings line of the gate pass (the project's own, in
// `.sandcastle/logs/timings.jsonl`), and one line per sandbox in the machine-wide `peaks.jsonl`
// beside the live-runs directory (whose files go once a run has ended and its tab no longer needs a report); both carry the
// highest `pressureSome` and `pressureFull` where one was above 0. A peaks line carries a time, the
// run, a hash of the project root (no path, no name) and `sampled`, which version of the reading above
// its `anon` figures rest on. Best effort throughout: a file that is
// missing (cgroup v1, an older kernel), a sandbox that is gone or a cache directory that cannot be
// written records nothing and never fails the pass.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KIT_CACHE, real } from "./live-runs.ts";

export const PEAKS_FILE = join(KIT_CACHE, "peaks.jsonl");
const MEMORY_PEAK = "/sys/fs/cgroup/memory.peak";
const MEMORY_STAT = "/sys/fs/cgroup/memory.stat";
const MEMORY_PRESSURE = "/sys/fs/cgroup/memory.pressure";
// The read is one `cat`; a sandbox that does not answer in this time is read as having no figure,
// so a closing sandbox's last read cannot hold up the run.
const READ_LIMIT_MS = 10_000;
const SAMPLE_EVERY_MS = 10_000;
// Which reading a line's `anonMib` and `agentAnonMib` rest on. 2: only readings taken while a phase ran. A line
// without it (written before this marker) may hold the sandbox at rest, which reads about 1 MiB, with nothing on
// the line to say so, so `measuredPeak` (src/size.ts) leaves those two figures out.
export const SAMPLED = 2;
// `full` pressure (percent, avg10) at which a run's report warns: all of a sandbox's tasks were stalled on memory for
// this share of 10 s. The kernel's own documentation treats any sustained `full` as a sign of thrashing; the faults
// the ticket saw (retried page faults, no kills) cost gates minutes while it was a few percent.
export const PRESSURE_WARN_FULL = 5;

export type Exec = { exec(cmd: string): Promise<{ exitCode: number; stdout: string }> };
/**
 * One sandbox's peak. `run` is the run's start time: the runs a project's peaks count are told apart by it.
 * `peakMib` is the whole life's `memory.peak`, page cache included; `anonMib` the largest anonymous memory
 * (no page cache) read while a gate pass ran. `agentMib` is `memory.peak` just before the first gate pass and
 * `agentAnonMib` the largest anonymous memory read while an agent pass ran: only a ticket's sandbox whose
 * agents ran has them (a land-only re-run's has them only if a narrow review ran there, after a resolve or for a
 * carried merge), so a line without `agentMib` (base, verify, landing, every older line) is a gate peak only.
 * `sampled` marks a line whose two anon figures were read only while a phase ran (`SAMPLED`). `pressureSome` and
 * `pressureFull` are the highest `avg10` (percent) of the sandbox's memory pressure read while any phase ran. Each
 * optional figure is absent where the kernel gave none (a pressure of 0 is left off too).
 */
export type PeakLine = {
  ts: string; project: string; run: string; peakMib: number; anonMib?: number; agentMib?: number; agentAnonMib?: number; sampled?: number;
  pressureSome?: number; pressureFull?: number;
};

/** Memory pressure as percentages (`avg10`): `some` is any task stalled, `full` all of them. */
export type Pressure = { some?: number; full?: number };

/** A hash of the project root, as the peaks file names a project: the same project by any path (symlinks resolved) is one. */
export const projectId = (root: string) => createHash("sha256").update(real(root)).digest("hex").slice(0, 12);

/** The sandbox's high-water mark so far in MiB (rounded up), or undefined where the kernel gives none. */
export const readPeakMib = async (sandbox: Exec): Promise<number | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), READ_LIMIT_MS);
      // A read still out when its pass ends must not keep the process alive (the Node 24 exit rule, test/cli-spawn.ts).
      timer.unref();
    });
    const r = await Promise.race([sandbox.exec(`cat ${MEMORY_PEAK} 2>/dev/null`), limit]);
    const text = r?.exitCode === 0 ? String(r.stdout ?? "").trim() : "";
    if (!/^\d+$/.test(text)) return undefined;
    const mib = Math.ceil(Number(text) / 2 ** 20);
    return mib > 0 ? mib : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** The sandbox's anonymous memory now in MiB (rounded up) from `memory.stat`, or undefined where the kernel gives none. */
export const readAnonMib = async (sandbox: Exec): Promise<number | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), READ_LIMIT_MS);
      timer.unref();
    });
    const r = await Promise.race([sandbox.exec(`cat ${MEMORY_STAT} 2>/dev/null`), limit]);
    const bytes = r?.exitCode === 0 ? /^anon (\d+)$/m.exec(String(r.stdout ?? "")) : null;
    const mib = bytes ? Math.ceil(Number(bytes[1]) / 2 ** 20) : 0;
    return mib > 0 ? mib : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** The sandbox's memory pressure now (`avg10` of `some` and `full`, percent), or undefined where the kernel gives none. */
export const readPressure = async (sandbox: Exec): Promise<Pressure | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), READ_LIMIT_MS);
      timer.unref();
    });
    const r = await Promise.race([sandbox.exec(`cat ${MEMORY_PRESSURE} 2>/dev/null`), limit]);
    const text = r?.exitCode === 0 ? String(r.stdout ?? "") : "";
    const avg10 = (kind: string) => {
      const m = new RegExp(`^${kind} .*\\bavg10=(\\d+(?:\\.\\d+)?)`, "m").exec(text);
      return m ? Number(m[1]) : undefined;
    };
    const some = avg10("some");
    const full = avg10("full");
    return some === undefined && full === undefined ? undefined : { ...(some !== undefined ? { some } : {}), ...(full !== undefined ? { full } : {}) };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

// The largest reading of each sandbox so far. `memory.peak` only rises unless something resets it,
// so the largest is what the sandbox peaked at either way.
const largest = new WeakMap<object, number>();
const largestAnon = { gate: new WeakMap<object, number>(), agent: new WeakMap<object, number>() };
const agentPeak = new WeakMap<object, number>();
const highestPressure = new WeakMap<object, Pressure>();

type Phase = keyof typeof largestAnon;
const noteAnon = (sandbox: Exec, phase: Phase, mib: number | undefined) => {
  if (mib !== undefined) largestAnon[phase].set(sandbox, Math.max(largestAnon[phase].get(sandbox) ?? 0, mib));
};

/** Raises `into` (the sandbox's, and a pass's own when given) to the reading's `some` and `full`. */
const notePressure = (sandbox: Exec, p: Pressure | undefined, pass?: Pressure) => {
  if (!p) return;
  const sandboxes = highestPressure.get(sandbox) ?? {};
  for (const into of [sandboxes, ...(pass ? [pass] : [])]) {
    if (p.some !== undefined) into.some = Math.max(into.some ?? 0, p.some);
    if (p.full !== undefined) into.full = Math.max(into.full ?? 0, p.full);
  }
  highestPressure.set(sandbox, sandboxes);
};

const readLargest = async (sandbox: Exec): Promise<number | undefined> => {
  const mib = await readPeakMib(sandbox);
  if (mib !== undefined) largest.set(sandbox, Math.max(largest.get(sandbox) ?? 0, mib));
  return mib;
};

/**
 * Reads the sandbox's peak after a gate pass and returns the largest peak so far, or undefined when it never gave one.
 * Its `anon` is not read here: the gate has ended, so that is the sandbox at rest (`sampling` reads it while one runs).
 */
export const samplePeak = async (sandbox: Exec): Promise<number | undefined> => {
  await readLargest(sandbox);
  return largest.get(sandbox);
};

/**
 * Runs `fn`, a gate or an agent pass, reading the sandbox's anonymous memory once as it starts and every 10 s
 * while it runs. The first read is what gives a pass shorter than 10 s a reading taken during it: it is issued
 * with the pass, and waited for when the pass ends first. The timer is unref'd and cleared when `fn` settles, and
 * a periodic reading that answers after that is dropped: an agent at rest after a gate is not the gate's figure.
 * The sandbox's memory pressure is read with it; `pass`, when given, collects the highest of this pass alone.
 */
export const sampling = async <T>(sandbox: Exec, phase: Phase, fn: () => Promise<T>, pass?: Pressure): Promise<T> => {
  let ended = false;
  let reading = false;
  const read = (late: boolean) => {
    // One read at a time: a sandbox slow to answer must not pile up `cat`s.
    if (reading) return undefined;
    reading = true;
    return Promise.all([readAnonMib(sandbox), readPressure(sandbox)]).then(([mib, pressure]) => {
      reading = false;
      if (!ended || late) {
        noteAnon(sandbox, phase, mib);
        notePressure(sandbox, pressure, pass);
      }
    });
  };
  const timer = setInterval(() => void read(false), SAMPLE_EVERY_MS);
  timer.unref();
  const first = read(true);
  try {
    return await fn();
  } finally {
    ended = true;
    clearInterval(timer);
    // Issued while the pass ran, so what it answers describes the pass; `readAnonMib` bounds the wait.
    await first;
  }
};

/** The agent baseline: the sandbox's `memory.peak` before its first gate pass, read once; a later call reads nothing. */
export const agentBaseline = async (sandbox: Exec): Promise<void> => {
  if (agentPeak.has(sandbox)) return;
  const mib = await readLargest(sandbox);
  if (mib !== undefined) agentPeak.set(sandbox, mib);
};

/** The `peakMib` a step's result carries (a gate pass), or undefined for any other step. */
export const peakOf = (result: unknown): number | undefined => {
  const p = (result as { peakMib?: unknown } | undefined)?.peakMib;
  return typeof p === "number" && p > 0 ? p : undefined;
};

/** The `pressureSome` and `pressureFull` a step's result carries (a gate pass), as `Pressure`; undefined when it carries neither. */
export const pressureOf = (result: unknown): Pressure | undefined => {
  const r = result as { pressureSome?: unknown; pressureFull?: unknown } | undefined;
  const some = typeof r?.pressureSome === "number" && r.pressureSome > 0 ? r.pressureSome : undefined;
  const full = typeof r?.pressureFull === "number" && r.pressureFull > 0 ? r.pressureFull : undefined;
  return some === undefined && full === undefined ? undefined : { ...(some !== undefined ? { some } : {}), ...(full !== undefined ? { full } : {}) };
};

/** A pass's pressure as the fields a gate run and its timings line carry; only a figure above 0. */
export const pressureFields = (p: Pressure | undefined): { pressureSome?: number; pressureFull?: number } => ({
  ...(p?.some ? { pressureSome: p.some } : {}),
  ...(p?.full ? { pressureFull: p.full } : {}),
});

/**
 * The last read of the peak, before the sandbox closes, and the sandbox's line in `peaks.jsonl`. Called once per
 * sandbox. Nothing is written when no reading was ever possible.
 */
export const recordPeak = async (sandbox: Exec, root: string, run: string = new Date().toISOString(), file = PEAKS_FILE, now = new Date()): Promise<number | undefined> => {
  // Only the peak: `anon` read here is the sandbox at rest, which describes no phase.
  await readLargest(sandbox);
  const peakMib = largest.get(sandbox);
  if (peakMib === undefined) return undefined;
  const anonMib = largestAnon.gate.get(sandbox);
  const agentMib = agentPeak.get(sandbox);
  const agentAnonMib = largestAnon.agent.get(sandbox);
  const pressure = highestPressure.get(sandbox);
  const line: PeakLine = {
    ts: now.toISOString(),
    project: projectId(root),
    run,
    peakMib,
    sampled: SAMPLED,
    ...pressureFields(pressure),
    ...(anonMib ? { anonMib } : {}),
    ...(agentMib ? { agentMib } : {}),
    ...(agentAnonMib ? { agentAnonMib } : {}),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(line) + "\n");
  } catch {
    /* a cache directory that cannot be written must not stop a run */
  }
  return peakMib;
};

/** Every well-formed line of the peaks file; an unreadable file or a bad line is skipped. */
export const readPeaks = (file = PEAKS_FILE): PeakLine[] => {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines: PeakLine[] = [];
  for (const raw of text.split("\n")) {
    try {
      const l = JSON.parse(raw) as Partial<PeakLine>;
      if (typeof l.project === "string" && typeof l.ts === "string" && Number.isFinite(Date.parse(l.ts)) && typeof l.peakMib === "number" && l.peakMib > 0) {
        const optional = Object.fromEntries((["anonMib", "agentMib", "agentAnonMib", "sampled", "pressureSome", "pressureFull"] as const).flatMap((k) => (typeof l[k] === "number" && l[k] > 0 ? [[k, l[k]]] : [])));
        lines.push({ ts: l.ts, project: l.project, run: typeof l.run === "string" ? l.run : `ts:${l.ts}`, peakMib: l.peakMib, ...optional });
      }
    } catch {
      /* blank or half-written line */
    }
  }
  return lines;
};
