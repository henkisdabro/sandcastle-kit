// Each sandbox's peak memory, so `sandcastle size` recommends from what runs used rather than a
// guess. The kernel keeps the high-water mark itself (cgroup v2 `memory.peak`, in bytes), so it is
// read from inside the container after each gate pass and again before the sandbox closes: no
// host-side polling, and nothing to name or find a container by. A gate pass runs in the agent's
// own sandbox (base and verify gates in a throwaway one), so the sandbox's peak covers its gates.
//
// Two records: a `peakMib` on the timings line of the gate pass (the project's own, in
// `.sandcastle/logs/timings.jsonl`), and one line per sandbox in the machine-wide `peaks.jsonl`
// beside the live-runs directory (whose files go when a run ends). A peaks line carries a time, the
// run, and a hash of the project root: no path, no name. Best effort throughout: a file that is
// missing (cgroup v1, an older kernel), a sandbox that is gone or a cache directory that cannot be
// written records nothing and never fails the pass.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KIT_CACHE, real } from "./live-runs.ts";

export const PEAKS_FILE = join(KIT_CACHE, "peaks.jsonl");
const MEMORY_PEAK = "/sys/fs/cgroup/memory.peak";
// The read is one `cat`; a sandbox that does not answer in this time is read as having no figure,
// so a closing sandbox's last read cannot hold up the run.
const READ_LIMIT_MS = 10_000;

export type Exec = { exec(cmd: string): Promise<{ exitCode: number; stdout: string }> };
/** One sandbox's peak. `run` is the run's start time: the runs a project's peaks count are told apart by it. */
export type PeakLine = { ts: string; project: string; run: string; peakMib: number };

/** A hash of the project root, as the peaks file names a project: the same project by any path (symlinks resolved) is one. */
export const projectId = (root: string) => createHash("sha256").update(real(root)).digest("hex").slice(0, 12);

/** The sandbox's high-water mark so far in MiB (rounded up), or undefined where the kernel gives none. */
export const readPeakMib = async (sandbox: Exec): Promise<number | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), READ_LIMIT_MS);
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

// The largest reading of each sandbox so far. `memory.peak` only rises unless something resets it,
// so the largest is what the sandbox peaked at either way.
const largest = new WeakMap<object, number>();

/** Reads the sandbox's peak and returns the largest it has shown so far, or undefined when it never gave one. */
export const samplePeak = async (sandbox: Exec): Promise<number | undefined> => {
  const mib = await readPeakMib(sandbox);
  if (mib !== undefined) largest.set(sandbox, Math.max(largest.get(sandbox) ?? 0, mib));
  return largest.get(sandbox);
};

/** The `peakMib` a step's result carries (a gate pass), or undefined for any other step. */
export const peakOf = (result: unknown): number | undefined => {
  const p = (result as { peakMib?: unknown } | undefined)?.peakMib;
  return typeof p === "number" && p > 0 ? p : undefined;
};

/**
 * The last read, before the sandbox closes, and the sandbox's line in `peaks.jsonl`. Called once per
 * sandbox. Nothing is written when no reading was ever possible.
 */
export const recordPeak = async (sandbox: Exec, root: string, run: string = new Date().toISOString(), file = PEAKS_FILE, now = new Date()): Promise<number | undefined> => {
  const peakMib = await samplePeak(sandbox);
  if (peakMib === undefined) return undefined;
  const line: PeakLine = { ts: now.toISOString(), project: projectId(root), run, peakMib };
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
        lines.push({ ts: l.ts, project: l.project, run: typeof l.run === "string" ? l.run : `ts:${l.ts}`, peakMib: l.peakMib });
      }
    } catch {
      /* blank or half-written line */
    }
  }
  return lines;
};
