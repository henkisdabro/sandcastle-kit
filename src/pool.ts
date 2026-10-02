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
// whose pid is gone is stale and taken over, so a killed run never leaks one.
// The run lock (guard.ts) is the same kind of file, taken the same way.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OperatorError } from "./errors.ts";
import { machineSettings } from "./sandbox.ts";

export type PoolName = "sandboxes" | "gates";

const DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "sandcastle-kit", "slots");

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

export const limit = (pool: PoolName): number => {
  const s = SETTING[pool];
  // Name the setting the value came from: an operator told about an env var
  // they never set looks for the wrong thing.
  const fromEnv = process.env[s.env] !== undefined;
  return (settings[pool] ??= wholeNumber(fromEnv ? s.env : s.key, fromEnv ? process.env[s.env] : (machineSettings()[s.key] ?? s.fallback), 1));
};

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
 * with) if taken, `owner` if a live process holds it, neither if it is busy for
 * a moment (being written or taken over) - try again later.
 *
 * The content is "<pid> <token> <label>": the pid first, which status.sh reads;
 * the token, so a release never removes a lock someone else took since. A lock
 * whose pid is dead is taken over under `<file>.takeover`, and only if it still
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
    if (stale && alive(pid)) return { owner: pid };
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
process.on("exit", () => {
  for (const [file, mine] of held) releaseLock(file, mine);
});

const tryAcquire = (pool: PoolName, label: string): { file: string; mine: string } | undefined => {
  mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < limit(pool); i++) {
    const file = join(DIR, `${pool}-${i}.lock`);
    const { mine } = takeLock(file, label);
    if (mine) return { file, mine };
  }
  return undefined;
};

/** Waits for a slot, runs `fn`, frees the slot. `onWait` is told when no slot was free. */
export const withSlot = async <T>(pool: PoolName, label: string, fn: () => Promise<T>, onWait?: () => void): Promise<T> => {
  let slot = tryAcquire(pool, label);
  if (!slot) {
    console.log(`  ${label}: waiting for a machine-wide ${pool} slot (${limit(pool)} in use)`);
    onWait?.();
  }
  while (!slot) {
    await new Promise((r) => setTimeout(r, 5000));
    slot = tryAcquire(pool, label);
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
export const usage = () =>
  (["sandboxes", "gates"] as const)
    .map((pool) => {
      const used = existsSync(DIR)
        ? readdirSync(DIR).filter((f) => {
            // Not a `.takeover` guard: that is a slot changing hands, not a second one.
            if (!f.startsWith(`${pool}-`) || !f.endsWith(".lock")) return false;
            const content = read(join(DIR, f));
            return !!content && alive(Number(content.split(" ")[0]));
          }).length
        : 0;
      return `${pool} ${used}/${limit(pool)}`;
    })
    .join(" · ");
