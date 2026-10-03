// Machine-wide limits, shared by every sandcastle run on this machine, so two
// projects running at once cannot oversubscribe it.
//
//   sandboxes - live sandboxes across all runs. Agents mostly wait on the
//               model, so this caps memory and the draw on a shared plan
//               allowance more than CPU. Default 6.
//   gates     - gate runs (build, tests) at once across all runs. Gates are
//               the CPU-heavy part: 12 sandboxes gating together on a 15-core
//               machine once pushed load to 33 and starved a test run into a
//               false red. Default 2.
//
// Set in ~/.config/sandcastle-kit/config.json ({"maxSandboxes": 6, "maxGates": 2})
// or SANDCASTLE_MAX_SANDBOXES / SANDCASTLE_MAX_GATES. A project's CONCURRENCY
// still applies inside the machine-wide cap.
//
// A slot is a lock file holding the owner's pid, created with O_EXCL. A slot
// whose owner is gone is stale and taken over, so a killed run never leaks one.
// It also names the run that holds it (`run=<id>`), so the pool can count slots per run.
//
// A freed slot goes to the longest wait across runs. A run that wants a slot writes a wait
// entry (`waits/`) with the time it began, and takes a free slot only when no other live run
// has an older entry for that pool: without it, a run that has just freed a slot asks again at
// once and almost always wins, and a second project's run waits until the first drains. A wait
// entry whose process is gone is ignored and removed, by the same rule as a stale slot.
// Within one run nothing is ordered here: its own waiters poll as they always did, and
// `slotTurn` (landing.ts) puts a landing before the run's next pipeline.
// The run lock (guard.ts) is the same kind of file, taken the same way. An owner
// is a process of the kit (its command line holds RUN_COMMAND, as for a run):
// a killed run's pid comes round as some other process, and the lock would
// otherwise be held for as long as that one lasts.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isKit, type Probe } from "../mod/hooks/run-live.ts";
import { OperatorError } from "./errors.ts";
import { commandOf } from "./live-runs.ts";
import { machineSettings } from "./sandbox.ts";

export type PoolName = "sandboxes" | "gates";

const DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "sandcastle-kit", "slots");
// A subdirectory, so status.sh's `<pool>-*.lock` glob and `usage` never see an entry.
const WAITS = join(DIR, "waits");

/** This process's run, as its slot locks and wait entries name it: one id per process, never reused. */
export const RUN_ID = randomUUID().slice(0, 8);

/**
 * `raw` as a whole number of `min` or more, or an OperatorError naming it.
 * Number() alone turns "abc" into NaN, which every `<` and Math.min then
 * swallows: no worker starts, or a slot wait never ends.
 */
export const wholeNumber = (name: string, raw: unknown, min: number): number => {
  const text = typeof raw === "string" ? raw.trim() : raw;
  const n = typeof text === "number" || (typeof text === "string" && text !== "") ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < min) throw new OperatorError(`${name}=${raw} - expected a whole number of ${min} or more.`);
  return n;
};

// Read on first use, not at import: a bad value must break only the commands
// that use the pool, never `sandcastle doctor`, `setup` or `help`, which have
// to run to diagnose it.
const settings: Partial<Record<PoolName, number>> = {};
const SETTING = {
  sandboxes: { env: "SANDCASTLE_MAX_SANDBOXES", key: "maxSandboxes", fallback: 6 },
  gates: { env: "SANDCASTLE_MAX_GATES", key: "maxGates", fallback: 2 },
} as const;

/** A pool's limit from the given environment and machine settings; `limit` is this over the process's own. */
export const poolLimit = (pool: PoolName, env: Record<string, string | undefined>, machine: Record<string, unknown>): number => {
  const s = SETTING[pool];
  // Name the setting the value came from: an operator told about an env var
  // they never set looks for the wrong thing.
  const fromEnv = env[s.env] !== undefined;
  return wholeNumber(fromEnv ? s.env : s.key, fromEnv ? env[s.env] : (machine[s.key] ?? s.fallback), 1);
};

export const limit = (pool: PoolName): number => (settings[pool] ??= poolLimit(pool, process.env, machineSettings()));

const exists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The lock's owner is still running: a process of the kit holds the pid. When `ps` cannot say
 * what the pid is (no `-p`, as in BusyBox, or `ps` failing) but the process exists, the lock is
 * kept: a live run misread as gone would let a second one take the same project, while a
 * recycled pid kept for want of an answer only waits for a later look.
 */
export const holderRunning = (pid: number, probe: Probe = commandOf): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const command = probe(pid);
  return command === undefined ? exists(pid) : isKit(command);
};

// A lock that vanished between two calls reads as undefined: its owner
// released it, which is no reason to crash the pipeline asking.
const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
const age = (file: string) => {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
// Longer than any takeover or lock write takes: a guard or an empty lock this
// old was left by a process killed in the middle of one.
const WEDGED_MS = 10_000;

/**
 * Takes the lock `file` for this process: `mine` (its content, to release it
 * with) if taken, `owner` if a live process of the kit holds it, neither if it is busy for
 * a moment (being written or taken over) - try again later.
 *
 * The content is "<pid> <token> <label>": the pid first, which status.sh reads;
 * the token, so a release never removes a lock someone else took since. A lock
 * whose owner is gone (`holderRunning`: its pid is dead, or is some other process
 * now) is taken over under `<file>.takeover`, and only if it still
 * holds the same stale content: two runs that both saw it stale once both
 * unlinked it, the second removing the first's fresh lock, and both ran.
 */
export const takeLock = (file: string, label: string): { mine?: string; owner?: number } => {
  const mine = `${process.pid} ${randomUUID()} ${label}\n`;
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(file, mine, { flag: "wx" });
      return { mine };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stale = read(file);
    if (stale === undefined) continue; // released since - try again
    // Empty is a lock being written, unless it has been empty for too long.
    if (!stale && age(file) < WEDGED_MS) return {};
    const pid = Number(stale.split(" ")[0]);
    if (stale && holderRunning(pid)) return { owner: pid };
    const guard = `${file}.takeover`;
    try {
      writeFileSync(guard, `${process.pid}\n`, { flag: "wx" });
    } catch {
      // Another process is taking it over. A guard left by one killed inside
      // it would block the lock for good, so an old one goes.
      if (age(guard) > WEDGED_MS) rmSync(guard, { force: true });
      return {};
    }
    try {
      if (read(file) !== stale) continue; // someone took it, or it was released
      rmSync(file, { force: true });
      writeFileSync(file, mine, { flag: "wx" });
      return { mine };
    } catch {
      return {};
    } finally {
      rmSync(guard, { force: true });
    }
  }
  return {};
};

/** Removes the lock only if it is still the one `mine` took. */
export const releaseLock = (file: string, mine: string) => {
  if (read(file) === mine) rmSync(file, { force: true });
};

const held = new Map<string, string>();
const waiting = new Set<string>();
process.on("exit", () => {
  for (const [file, mine] of held) releaseLock(file, mine);
  for (const file of waiting) rmSync(file, { force: true });
});

export type SlotLock = { pid: number; run: string; label: string };

/**
 * A slot lock's content ("<pid> <token> run=<id> <label>"). A lock from a kit that did not name
 * its run reads as a run of its own pid: it still counts, and is never mistaken for another's.
 */
const parseLock = (content: string): SlotLock => {
  const [pid, , second, ...rest] = content.trim().split(" ");
  const named = second?.startsWith("run=");
  return { pid: Number(pid), run: named ? second.slice(4) : `pid:${pid}`, label: (named ? rest : [second, ...rest]).filter(Boolean).join(" ") };
};

/** The pool's slots held by a live run now. */
export const liveSlots = (pool: PoolName): SlotLock[] => {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.startsWith(`${pool}-`) && f.endsWith(".lock")) // not a `.takeover` guard: that is a slot changing hands
    .flatMap((f) => {
      const content = read(join(DIR, f));
      const lock = content ? parseLock(content) : undefined;
      return lock && holderRunning(lock.pid) ? [lock] : [];
    });
};

/** How many of the pool's slots each live run holds, by run id. */
export const slotsByRun = (pool: PoolName): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const { run } of liveSlots(pool)) counts.set(run, (counts.get(run) ?? 0) + 1);
  return counts;
};

type Wait = { file: string; pid: number; run: string; since: number };

/** The live waits for `pool`; an entry left by a dead process is removed, one that cannot be read is skipped. */
const waits = (pool: PoolName): Wait[] => {
  if (!existsSync(WAITS)) return [];
  return readdirSync(WAITS)
    .filter((f) => f.startsWith(`${pool}-`) && f.endsWith(".wait"))
    .flatMap((f) => {
      const file = join(WAITS, f);
      const [pid, run, since] = (read(file) ?? "").split(" ");
      if (!since) return [];
      if (!holderRunning(Number(pid))) {
        rmSync(file, { force: true });
        return [];
      }
      return [{ file, pid: Number(pid), run, since: Number(since) }];
    });
};

/** Another live run has waited for this pool longer than `mine` (ties go to the lower run id). */
const olderWait = (pool: PoolName, mine: Wait) =>
  waits(pool).some((w) => w.run !== mine.run && (w.since < mine.since || (w.since === mine.since && w.run < mine.run)));

let sequence = 0;
// Written whole, then renamed in: a reader never sees an entry half-written.
const beginWait = (pool: PoolName, label: string): Wait => {
  mkdirSync(WAITS, { recursive: true });
  const since = Date.now();
  const file = join(WAITS, `${pool}-${since}-${RUN_ID}-${sequence++}.wait`);
  writeFileSync(`${file}.tmp`, `${process.pid} ${RUN_ID} ${since} ${label}\n`);
  renameSync(`${file}.tmp`, file);
  waiting.add(file);
  return { file, pid: process.pid, run: RUN_ID, since };
};
const endWait = (wait: Wait) => {
  waiting.delete(wait.file);
  rmSync(wait.file, { force: true });
};

const tryAcquire = (pool: PoolName, label: string): { file: string; mine: string } | undefined => {
  mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < limit(pool); i++) {
    const file = join(DIR, `${pool}-${i}.lock`);
    const { mine } = takeLock(file, label);
    if (mine) return { file, mine };
  }
  return undefined;
};

/**
 * Waits for a slot, runs `fn`, frees the slot. `onWait` is told when no slot was free. The slot
 * goes to the run that has waited longest; `pollMs` is how often a wait looks again.
 */
export const withSlot = async <T>(pool: PoolName, label: string, fn: () => Promise<T>, onWait?: () => void, pollMs = 5000): Promise<T> => {
  const wait = beginWait(pool, label);
  let slot: ReturnType<typeof tryAcquire>;
  try {
    let yielded = olderWait(pool, wait);
    slot = yielded ? undefined : tryAcquire(pool, `run=${RUN_ID} ${label}`);
    if (!slot) {
      console.log(`  ${label}: waiting for a machine-wide ${pool} slot (${yielded ? "another run has waited longer" : `${limit(pool)} in use`})`);
      onWait?.();
    }
    while (!slot) {
      await new Promise((r) => setTimeout(r, pollMs));
      yielded = olderWait(pool, wait);
      slot = yielded ? undefined : tryAcquire(pool, `run=${RUN_ID} ${label}`);
    }
  } finally {
    endWait(wait);
  }
  held.set(slot.file, slot.mine);
  try {
    return await fn();
  } finally {
    held.delete(slot.file);
    releaseLock(slot.file, slot.mine);
  }
};

/** "sandboxes 3/6 · gates 1/2" - live slots only; read by status.sh too. */
export const usage = () => (["sandboxes", "gates"] as const).map((pool) => `${pool} ${liveSlots(pool).length}/${limit(pool)}`).join(" · ");
