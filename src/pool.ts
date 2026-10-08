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
// Within one run, a waiter that asks for priority (`withSlot`'s last argument: a landing's sandbox, and the
// gates a landing, the base check and the verify make, which the run's end waits on) goes before the run's
// other waiters for the same pool, and counts from the run's oldest wait, so the run is picked as before; the
// run's other waiters go in the order they began waiting (the earliest first, ties in the order they asked), and
// `slotTurn` (landing.ts) keeps the run's next pipeline from asking for a sandbox slot while a landing waits for one.
// Which ticket a pipeline's slot serves is the run's start queue's to say, not the pool's: a worker leases its slot
// first and then takes the head of the queue (slot first, src/schedule.ts), so a requeued or released ticket gets the
// next slot the run is granted.
//
// Shares (docs/adr/0001): live runs split the sandbox slots equally between them, up to each
// run's demand. A run registers (`joinPool`: `runs/<id>.run`, written whole and renamed in) with
// its project, its demand and that it knows shares; liveness is the stale-lock rule. A run at or
// above its share (the slots it holds count) takes no new sandbox slot while another run below
// its share wants one, and never loses one it holds. A run with slots and no registration is from an
// older kit: it is counted as wanting its concurrency (its run record's), or the slots it holds.
// A run that starts beside others says how the pool is split (`startLines`), and its estimate divides by its share.
// Beside another run, a run's ticket pipelines (`keep`) leave the last slot of its share, at 2 or more, to its
// landings (`keptForLanding`).
// The gates pool has no shares.
//
// A cap (`sandcastle cap`) is a person's limit on one run's share, in that run's registration, so it
// ends with the run. It only lowers the share: the run's demand for the split is the smaller of its
// demand and its cap, and a run holding its cap takes no slot even when no other run wants one.
// A run above its cap keeps the slots it holds, as above its share.
//
// The run lock (guard.ts) is the same kind of file, taken the same way. An owner
// is a process of the kit (its command line holds RUN_COMMAND, as for a run):
// a killed run's pid comes round as some other process, and the lock would
// otherwise be held for as long as that one lasts.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isKit, type Probe } from "../mod/hooks/run-live.ts";
import type { RunRecord } from "../mod/hooks/run-record.ts";
import { OperatorError } from "./errors.ts";
import { commandOf, KIT_CACHE, RUNS_DIR } from "./live-runs.ts";
import { machineSettings } from "./sandbox.ts";

export type PoolName = "sandboxes" | "gates";

// Under live-runs.ts's KIT_CACHE, so an empty XDG_CACHE_HOME is unset here too, not a relative path.
export const DIR = join(KIT_CACHE, "slots");
// A subdirectory, so status.sh's `<pool>-*.lock` glob and `usage` never see an entry.
const WAITS = join(DIR, "waits");
const RUNS = join(DIR, "runs");

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

// What the pool asks the machine: which process a pid is, and what time it is. The kit's own
// answers unless a test says otherwise (`inject`), so a test can drive several runs' files in one
// process, with no child process to start or `ps` to wait for.
let processOf: Probe = commandOf;
let clock = () => Date.now();

/** Replaces the process check and the clock the pool reads (a test's seam); with no argument, restores both. */
export const inject = (hooks: { probe?: Probe; now?: () => number } = {}) => {
  processOf = hooks.probe ?? commandOf;
  clock = hooks.now ?? (() => Date.now());
};

/**
 * The lock's owner is still running: a process of the kit holds the pid. When `ps` cannot say
 * what the pid is (no `-p`, as in BusyBox, or `ps` failing) but the process exists, the lock is
 * kept: a live run misread as gone would let a second one take the same project, while a
 * recycled pid kept for want of an answer only waits for a later look.
 */
export const holderRunning = (pid: number, probe: Probe = (p) => processOf(p)): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const command = probe(pid);
  return command === undefined ? exists(pid) : isKit(command);
};

/** Pids already asked about, so one look at the pool asks `ps` once per process, not once per file. */
type Seen = Map<number, boolean>;
const alive = (pid: number, seen?: Seen) => {
  if (!seen) return holderRunning(pid);
  if (!seen.has(pid)) seen.set(pid, holderRunning(pid));
  return seen.get(pid)!;
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
// This process's own waits, with what the entry files do not say: the pool and whether the wait asked for priority.
// `hidden`: its entry file is out of the waits directory while the slot kept for landing holds it back (`keptForLanding`).
type OwnWait = Wait & { pool: PoolName; priority: boolean; order: number; label: string; hidden?: boolean };
const waiting = new Set<OwnWait>();
// The sandbox slots this process holds for ticket pipelines (`leaseSlot`'s `keep`): what the slot kept for landing caps.
let keeping = 0;
let joined: Joined | undefined;
process.on("exit", () => {
  for (const [file, mine] of held) releaseLock(file, mine);
  for (const { file } of waiting) rmSync(file, { force: true });
  if (joined) rmSync(joined.file, { force: true });
});

/**
 * Runs `fn` holding the lock `file` (its directory made), waiting while a live process of the kit
 * holds it: the lock a step that must not overlap another project's takes, as the base image's
 * build does. `onWait` is told the owner's pid once, when the lock was taken; `pollMs` is how
 * often a wait looks again. A lock whose owner died is taken over by `takeLock`, and one this
 * process still holds at exit is released.
 */
export const withLock = async <T>(file: string, label: string, fn: () => Promise<T> | T, onWait?: (owner?: number) => void, pollMs = 1000): Promise<T> => {
  mkdirSync(dirname(file), { recursive: true });
  let told = false;
  let taken = takeLock(file, label);
  while (!taken.mine) {
    if (!told) {
      told = true;
      onWait?.(taken.owner);
    }
    await new Promise((r) => setTimeout(r, pollMs));
    taken = takeLock(file, label);
  }
  const { mine } = taken;
  held.set(file, mine);
  try {
    return await fn();
  } finally {
    held.delete(file);
    releaseLock(file, mine);
  }
};

/**
 * `withLock` for a caller that cannot wait on a promise: a read-then-write of one small file, made
 * whole under the lock so two processes' sequences never interleave. It sleeps in place between
 * looks (`Atomics.wait`, no busy spin) and takes over a lock whose owner died, as `takeLock` does.
 * A lock still held by a live process after `timeoutMs` is not worth stalling the caller for (a
 * run's loop calls this every second): `fn` then runs without it, as it would have before the lock existed.
 */
export const withLockSync = <T>(file: string, label: string, fn: () => T, timeoutMs = 5000, pollMs = 5): T => {
  mkdirSync(dirname(file), { recursive: true });
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  let taken = takeLock(file, label);
  while (!taken.mine && Date.now() < deadline) {
    Atomics.wait(nap, 0, 0, pollMs);
    taken = takeLock(file, label);
  }
  const { mine } = taken;
  if (!mine) return fn();
  held.set(file, mine);
  try {
    return fn();
  } finally {
    held.delete(file);
    releaseLock(file, mine);
  }
};

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
export const liveSlots = (pool: PoolName, seen?: Seen): SlotLock[] => {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.startsWith(`${pool}-`) && f.endsWith(".lock")) // not a `.takeover` guard: that is a slot changing hands
    .flatMap((f) => {
      const content = read(join(DIR, f));
      const lock = content ? parseLock(content) : undefined;
      return lock && alive(lock.pid, seen) ? [lock] : [];
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
const waits = (pool: PoolName, seen?: Seen): Wait[] => {
  if (!existsSync(WAITS)) return [];
  return readdirSync(WAITS)
    .filter((f) => f.startsWith(`${pool}-`) && f.endsWith(".wait"))
    .flatMap((f) => {
      const file = join(WAITS, f);
      const [pid, run, since] = (read(file) ?? "").split(" ");
      if (!since) return [];
      if (!alive(Number(pid), seen)) {
        rmSync(file, { force: true });
        return [];
      }
      return [{ file, pid: Number(pid), run, since: Number(since) }];
    });
};

/** A live run's registration: who it is and how many sandbox slots it could use now. */
export type Registration = { pid: number; run: string; project: string; demand: number; concurrency: number; since: number; cap?: number };

type Joined = { file: string; registration: Omit<Registration, "cap"> };

const parseRegistration = (text: string | undefined): Registration | undefined => {
  try {
    const r = JSON.parse(text ?? "") as Partial<Registration> & { shares?: boolean };
    // `shares` is the mark of a kit that knows them; a file without it is not one of ours.
    if (r.shares !== true || typeof r.run !== "string" || !Number.isInteger(r.pid) || !Number.isInteger(r.demand) || !Number.isInteger(r.since)) return undefined;
    const cap = Number.isInteger(r.cap) && r.cap! >= 1 ? r.cap : undefined;
    return { pid: r.pid!, run: r.run, project: String(r.project ?? ""), demand: Math.max(0, r.demand!), concurrency: Number(r.concurrency) || 0, since: r.since!, ...(cap ? { cap } : {}) };
  } catch {
    return undefined;
  }
};

/** The live registrations; one left by a dead process is removed, one that cannot be read is skipped. */
const registrations = (seen?: Seen): (Registration & { file: string })[] => {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((f) => f.endsWith(".run"))
    .flatMap((f) => {
      const file = join(RUNS, f);
      const r = parseRegistration(read(file));
      if (!r) return [];
      if (!alive(r.pid, seen)) {
        rmSync(file, { force: true });
        return [];
      }
      return [{ ...r, file }];
    });
};

// The tmp name is the writer's own: `sandcastle cap` rewrites a run's file from another process.
const writeFileWhole = (file: string, registration: Registration) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...registration, shares: true }) + "\n");
  renameSync(tmp, file);
};

/**
 * The cap is a person's, set from another process: the run's own copy of its registration never
 * holds it, so a rewrite for a new demand takes it from the file, or it would undo the cap.
 */
const writeRegistration = (j: Joined) => {
  const cap = parseRegistration(read(j.file))?.cap;
  writeFileWhole(j.file, { ...j.registration, ...(cap ? { cap } : {}) });
};

/**
 * Registers this process's run in the pool, beside the slot locks, so the other live runs can
 * work out their shares. Once per process: an autonomy run's next turn is the same run and
 * updates its demand. The registration goes when the process does. Every sandbox slot this
 * process takes after it stays within the run's share.
 */
export const joinPool = (project: string, concurrency: number, demand = 0) => {
  mkdirSync(RUNS, { recursive: true });
  joined ??= { file: join(RUNS, `${RUN_ID}.run`), registration: { pid: process.pid, run: RUN_ID, project, demand, concurrency, since: clock() } };
  joined.registration = { ...joined.registration, project, concurrency, demand };
  writeRegistration(joined);
};

/** Updates the run's demand, when it changed. Not registered: nothing to update. */
export const setDemand = (demand: number) => {
  if (!joined || joined.registration.demand === demand) return;
  joined.registration = { ...joined.registration, demand };
  writeRegistration(joined);
};

/** A run's record by its pid, found through the live-runs directory: the project's root and the record. Undefined when no record leads there. */
export const recordOfRun = (pid: number): { root: string; record: RunRecord } | undefined => {
  try {
    for (const f of readdirSync(RUNS_DIR)) {
      const root = read(join(RUNS_DIR, f))?.trim();
      if (!root) continue;
      let record: RunRecord;
      try {
        record = JSON.parse(read(join(root, ".sandcastle/logs/run.json")) ?? "");
      } catch {
        continue;
      }
      if (record.pid === pid) return { root, record };
    }
  } catch {
    /* no live-runs directory, or one that cannot be read */
  }
  return undefined;
};

/** A kit that wrote no registration is told by its pid: the concurrency its run record holds, if the live-runs directory leads to it. */
const concurrencyOfRun = (pid: number): number | undefined => {
  const concurrency = recordOfRun(pid)?.record.concurrency;
  return Number.isInteger(concurrency) && concurrency! > 0 ? concurrency : undefined;
};

/** One live run as the pool sees it: what it wants, what it holds and, for the sandbox pool, its share. */
export type Member = { run: string; project?: string; pid: number; demand: number; held: number; share: number; registered: boolean; since: number; cap?: number; concurrency?: number };

/**
 * The limit split equally between the runs that want slots, none above its demand: a run that
 * needs less than an equal part releases the rest to the others, again equally, until the pool
 * or every demand is met. Whole slots: the earlier of two equal runs (`since`, then `run`) gets
 * the odd one, so every run works out the same split from the same files. A capped run asks for
 * no more than its cap, so what the cap frees goes to the others like any unneeded part.
 */
export const splitShares = (total: number, wants: { run: string; demand: number; since: number; cap?: number }[]): Map<string, number> => {
  const shares = new Map<string, number>();
  let remaining = total;
  const asking = wants
    .map((w) => ({ ...w, demand: Math.min(w.demand, w.cap ?? Infinity) }))
    .filter((w) => w.demand > 0)
    .sort((a, b) => a.demand - b.demand || a.since - b.since || (a.run < b.run ? -1 : 1));
  asking.forEach((w, i) => {
    const share = Math.min(w.demand, Math.ceil(remaining / (asking.length - i)));
    shares.set(w.run, share);
    remaining -= share;
  });
  for (const w of wants) if (!shares.has(w.run)) shares.set(w.run, 0);
  return shares;
};

/**
 * Every live run that is registered or holds a sandbox slot, with its share of the pool.
 * A run with slots and no registration is from an older kit (or a command that is no run): it
 * wants its concurrency from its run record, or the slots it holds, and takes no share on trust.
 */
export const members = (pool: PoolName = "sandboxes", seen?: Seen): Member[] => {
  const registered = registrations(seen);
  const locks = liveSlots(pool, seen);
  const heldBy = new Map<string, number>();
  for (const { run } of locks) heldBy.set(run, (heldBy.get(run) ?? 0) + 1);
  const rows: Omit<Member, "share">[] = registered.map((r) => ({ run: r.run, project: r.project, pid: r.pid, demand: r.demand, held: heldBy.get(r.run) ?? 0, registered: true, since: r.since, cap: r.cap, concurrency: r.concurrency }));
  const known = new Set(registered.map((r) => r.run));
  for (const [run, count] of heldBy) {
    if (known.has(run)) continue;
    const pid = locks.find((l) => l.run === run)!.pid;
    rows.push({ run, pid, demand: concurrencyOfRun(pid) ?? count, held: count, registered: false, since: 0 });
  }
  const shares = splitShares(limit(pool), rows);
  return rows.map((r) => ({ ...r, share: shares.get(r.run) ?? 0 }));
};

/** This run's demand and share, or undefined when it has not joined the pool. */
export const myShare = (): { demand: number; share: number; held: number; cap?: number } | undefined => {
  if (!joined) return undefined;
  const me = members().find((m) => m.run === RUN_ID);
  return me && { demand: me.demand, share: me.share, held: me.held, ...(me.cap ? { cap: me.cap } : {}) };
};

/** The live runs other than this one that hold a sandbox slot or want one: the ones a run starting now has to share with. */
export const otherRuns = (): Member[] => members().filter((m) => m.run !== RUN_ID && (m.held > 0 || m.demand > 0));

/**
 * What a run that wants `demand` slots would get if it joined now beside `others`: its share of
 * the sandbox limit (the same split every run works out from the same files) and how many slots
 * are free this moment, which it can take without waiting for any run to finish a ticket.
 */
export const splitAtStart = (demand: number, others: Member[], total = limit("sandboxes")): { share: number; free: number } => {
  const shares = splitShares(total, [...others, { run: RUN_ID, demand, since: clock() }]);
  return { share: shares.get(RUN_ID) ?? 0, free: Math.max(0, total - others.reduce((n, m) => n + m.held, 0)) };
};

/**
 * The sandboxes the start estimate divides by: the run's workers within the share its tickets can use when another
 * run is live, else within the machine limit. Beside another run a share of 2 or more keeps one slot for landing
 * (`keptForLanding`), so the tickets count as share - 1; a share of 1, a run alone and a dry run (`landing` false:
 * it keeps nothing) count the whole share.
 */
export const estimateSlots = (workers: number, split?: { share: number }, landing = true, total = limit("sandboxes")) => {
  const share = split ? (landing && split.share >= 2 ? split.share - 1 : split.share) : Infinity;
  return Math.max(1, Math.min(workers, total, share));
};

/** Another live run as the start line tells it: `wait` is the seconds until its first ticket likely ends, when the history says. */
export type Neighbour = { project?: string; root?: string; pid?: number; registered: boolean; held: number; demand: number; wait?: number };

const slotsOf = (n: number) => `${n} slot${n === 1 ? "" : "s"}`;

/** Seconds as the start line says them, like the estimate's time: `12m`, `1h 05m`. */
const approx = (seconds: number) => {
  const m = Math.max(1, Math.round(seconds / 60));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/**
 * The start lines of a run that begins while others are live: who they are, what each holds and
 * wants, this run's share (and, from 2, the slot of it kept for landing) and, when no slot is free, when the first is likely. A run from an older
 * kit gets a line of its own - it takes no share on trust, and the run still starts. No other run:
 * no line. No history for the wait: the line leaves it out.
 *
 * A project name is the config's `name`, the same in every checkout of one repository, so a run whose
 * name another listed run (or this run, `self`) also has is named `site (site-review)`, with the last
 * component of its root, or `site (pid 4242)` where the root is unknown or another such run's folder
 * has the same last component. A name nothing shares is printed as it is.
 */
export const startLines = (split: { share: number; free: number }, others: Neighbour[], landing = true, self?: string): string[] => {
  const shared = (n: Neighbour) => !!n.project && (n.project === self || others.some((o) => o !== n && o.project === n.project));
  const folder = (n: Neighbour) => (n.root ? basename(n.root) : undefined);
  const name = (n: Neighbour) => {
    if (!n.project) return "another project";
    if (!shared(n)) return n.project;
    const dir = folder(n);
    if (dir && !others.some((o) => o !== n && shared(o) && o.project === n.project && folder(o) === dir)) return `${n.project} (${dir})`;
    return n.pid === undefined ? n.project : `${n.project} (pid ${n.pid})`;
  };
  const lines: string[] = [];
  const aware = others.filter((n) => n.registered);
  if (aware.length) {
    const live = aware.map((n) => `${name(n)} is live (${slotsOf(n.held)}, demand ${n.demand})`).join(" and ");
    const holders = others.filter((n) => n.held > 0);
    const waits = others.flatMap((n) => (n.wait === undefined ? [] : [n.wait]));
    const first = waits.length ? `, the first likely in ~${approx(Math.min(...waits))}` : "";
    const finish = `as ${holders.map((n) => `${name(n)}'s`).join(" and ")} tickets finish${first}`;
    const tail = split.free >= split.share ? "it starts at once" : split.free > 0 ? `it starts with ${slotsOf(split.free)} now and takes the rest ${finish}` : `it starts ${finish}`;
    const kept = landing && split.share >= 2 ? `, its tickets ${split.share - 1} at a time (one slot is kept for landing)` : "";
    lines.push(`${live}: this run's share is ${split.share}${kept}; ${tail}`);
  }
  for (const n of others) if (!n.registered) lines.push(`${name(n)}'s run predates shares: it keeps taking free slots until it ends`);
  return lines;
};

/** A run that could take a slot if one were free: one that knows no shares, or holds fewer than its share. */
const below = (m: Member | undefined) => !m || !m.registered || m.held < m.share;

/** Another live run has waited for this pool longer than `mine` (ties go to the lower run id), and could take a slot. */
const olderWait = (pool: PoolName, mine: Wait, ms: Member[], seen: Seen) =>
  waits(pool, seen).some(
    (w) => w.run !== mine.run && (w.since < mine.since || (w.since === mine.since && w.run < mine.run)) && (pool !== "sandboxes" || below(ms.find((m) => m.run === w.run))),
  );

/**
 * This run is at or above its share of the sandbox pool and another run below its share wants a
 * slot: a registered run below its share does (its demand is what it will ask for next, so a run
 * between two of its tickets is not mistaken for one that wants nothing), and so does any other
 * run with a wait entry. Not registered, or the gates pool: no shares. With no other run
 * wanting one, a free slot is taken as before.
 */
const overShare = (pool: PoolName, ms: Member[], seen: Seen) => {
  if (pool !== "sandboxes" || !joined) return false;
  const me = ms.find((m) => m.run === RUN_ID);
  if (below(me)) return false;
  // A cap is a limit whether or not another run wants the slot. Held, not share: a demand below the
  // cap leaves the share below it too, and a run with no rival takes slots past its share.
  if (me?.cap !== undefined && me.held >= me.cap) return true;
  if (ms.some((m) => m.run !== RUN_ID && m.registered && m.held < m.share)) return true;
  return waits(pool, seen).some((w) => w.run !== RUN_ID && !ms.find((m) => m.run === w.run)?.registered);
};

/**
 * Beside another run, while this run's share is 2 or more, its ticket pipelines (`keep`) hold no more than
 * share - 1 sandbox slots: the last of the share is kept for a landing, as `pipelineWorkers` keeps one of the
 * machine's slots for a run alone. Read at each look, as the share moves with every run's demand. At a share of 1
 * nothing is kept: the run's one slot is a ticket's, and a landing goes first when it frees.
 */
const keptForLanding = (ms: Member[]) => {
  if (!joined) return false;
  const me = ms.find((m) => m.run === RUN_ID);
  if (!me || me.share < 2) return false;
  if (!ms.some((m) => m.run !== RUN_ID && (m.held > 0 || m.demand > 0))) return false;
  return keeping >= me.share - 1;
};

let sequence = 0;
// Written whole, then renamed in: a reader never sees an entry half-written.
const writeWait = (wait: OwnWait) => {
  mkdirSync(WAITS, { recursive: true });
  writeFileSync(`${wait.file}.tmp`, `${wait.pid} ${wait.run} ${wait.since} ${wait.label}\n`);
  renameSync(`${wait.file}.tmp`, wait.file);
};
const beginWait = (pool: PoolName, label: string, priority: boolean): OwnWait => {
  const since = clock();
  const file = join(WAITS, `${pool}-${since}-${RUN_ID}-${sequence++}.wait`);
  const wait = { file, pid: process.pid, run: RUN_ID, since, pool, priority, order: sequence - 1, label };
  writeWait(wait);
  waiting.add(wait);
  return wait;
};
const endWait = (wait: OwnWait) => {
  waiting.delete(wait);
  rmSync(wait.file, { force: true });
};

/**
 * Where `wait` stands against the other runs. A priority wait counts from the oldest wait this run has
 * for the pool: the run is the one the slot goes to (the longest wait across runs), and the priority
 * wait is the one of its waiters that takes it. Any other wait counts from its own start, as it always did.
 */
const countedFrom = (wait: OwnWait): Wait => {
  if (!wait.priority) return wait;
  const oldest = Math.min(...[...waiting].filter((w) => w.pool === wait.pool).map((w) => w.since));
  return { ...wait, since: oldest };
};

/** This run has a priority wait for `pool` that is not `wait`: `wait` leaves the slot to it. */
const priorityAhead = (wait: OwnWait) => !wait.priority && [...waiting].some((w) => w.pool === wait.pool && w.priority);

/**
 * This run has a wait for `pool` that began before `wait`, and neither asked for priority: `wait` leaves the
 * slot to it. Each waiter polls on its own timer, so without this whichever asks at the moment a slot frees takes it.
 * A pipeline worker's wait names no ticket (it takes the head of the start queue once served), so this orders the
 * workers and a ticket resuming after a pause, never one ticket's rank against another's.
 */
const earlierAhead = (wait: OwnWait) =>
  !wait.priority && [...waiting].some((w) => w.pool === wait.pool && !w.priority && (w.since < wait.since || (w.since === wait.since && w.order < wait.order)));

const tryAcquire = (pool: PoolName, label: string): { file: string; mine: string } | undefined => {
  mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < limit(pool); i++) {
    const file = join(DIR, `${pool}-${i}.lock`);
    const { mine } = takeLock(file, label);
    if (mine) return { file, mine };
  }
  return undefined;
};

/** How long a wait is quiet before it says again why it waits: a reason that flips back and forth says nothing new. */
const REPRINT_MS = 15 * 60_000;

/**
 * Why a wait waits: every slot is taken, this run is at its share while another run waits below its own (or at its
 * cap), or the last slot of the run's share is kept for a landing (`keptForLanding`).
 */
export type WaitReason = "slots" | "share" | "landing";

/** A slot taken with `leaseSlot`: `release` frees it, once; a second call does nothing. */
export type SlotLease = { release(): void };

/**
 * Waits for a slot and hands it over: the caller frees it with `release()`. `withSlot` is this with
 * the release tied to a function's end; a ticket that closes its sandbox mid-way (a paused run) gives
 * its slot back and leases another when it resumes. `onWait` is told when no slot was free, and why
 * (again at each change of reason; the console line is said once, then every 15 minutes). The slot goes to the run that has waited longest, within each
 * run's share; `pollMs` is how often a wait looks again. With `giveUp`, asked at each look while no
 * slot is free, a wait that is no longer wanted (the run was paused) ends with no lease and no trace.
 * `priority` puts this wait before the run's other waits for the pool (the ones that did not ask for
 * it), without changing which run is served. `keep` is a ticket pipeline's sandbox slot: beside another run it
 * leaves the last slot of the run's share to a landing (`keptForLanding`), and waits with the reason `landing`.
 */
export function leaseSlot(pool: PoolName, label: string, onWait?: (why: WaitReason) => void, pollMs?: number, giveUp?: undefined, priority?: boolean, keep?: boolean): Promise<SlotLease>;
export function leaseSlot(pool: PoolName, label: string, onWait: ((why: WaitReason) => void) | undefined, pollMs: number | undefined, giveUp: () => boolean, priority?: boolean, keep?: boolean): Promise<SlotLease | undefined>;
export function leaseSlot(pool: PoolName, label: string, onWait?: (why: WaitReason) => void, pollMs = 5000, giveUp?: () => boolean, priority = false, keep = false): Promise<SlotLease | undefined> {
  return takeSlot(pool, label, onWait, pollMs, giveUp, priority, keep, (lease) => lease);
}

/**
 * The wait `leaseSlot` and `withSlot` share. `use` gets the lease in the same tick the slot is taken:
 * on a free slot `withSlot`'s `fn` starts before the call returns, with no microtask between, as it did
 * before there were leases (a test holds the slot and queues behind it in one go, and relies on it).
 */
async function takeSlot<T>(pool: PoolName, label: string, onWait: ((why: WaitReason) => void) | undefined, pollMs: number, giveUp: (() => boolean) | undefined, priority: boolean, keep: boolean, use: (lease: SlotLease) => T): Promise<Awaited<T> | undefined> {
  const wait = beginWait(pool, label, priority);
  let slot: ReturnType<typeof tryAcquire>;
  try {
    let told: WaitReason | undefined;
    let printedAt: number | undefined;
    let yielded: "run" | "priority" | "earlier" | "kept" | undefined;
    const attempt = (): WaitReason | undefined => {
      const seen: Seen = new Map();
      const ms = pool === "sandboxes" ? members(pool, seen) : [];
      yielded = undefined;
      if (overShare(pool, ms, seen)) return "share";
      // Out of the waits directory while kept: another run below its share would otherwise leave a free slot to
      // this older wait, which cannot take it, and both would wait until one of this run's tickets ended.
      const kept = keep && pool === "sandboxes" && keptForLanding(ms);
      if (kept !== !!wait.hidden) {
        if (kept) rmSync(wait.file, { force: true });
        else writeWait(wait);
        wait.hidden = kept;
      }
      if (kept) return (yielded = "kept"), "landing";
      if (olderWait(pool, countedFrom(wait), ms, seen)) return (yielded = "run"), "slots";
      if (priorityAhead(wait)) return (yielded = "priority"), "slots";
      if (earlierAhead(wait)) return (yielded = "earlier"), "slots";
      slot = tryAcquire(pool, `run=${RUN_ID} ${label}`);
      return slot ? undefined : "slots";
    };
    for (let why = attempt(); !slot; why = attempt()) {
      if (giveUp?.()) return undefined;
      // The line is said when the wait starts and again after REPRINT_MS, not at every change of reason:
      // with a second run live the reason alternates and one wait printed about 30 lines. `onWait` still
      // fires at each change, since the run's note of waiting for its share follows it.
      if (printedAt === undefined || clock() - printedAt >= REPRINT_MS) {
        printedAt = clock();
        const me = why === "share" || why === "landing" ? myShare() : undefined;
        const reason = yielded === "kept" ? `this run's share is ${me?.share ?? 0} and its tickets hold ${keeping}: one slot of it is kept for landing`
          : why === "share" ? `this run's share is ${me?.share ?? 0} and it holds ${me?.held ?? 0}, ${me?.cap !== undefined && me.held >= me.cap ? `capped at ${me.cap}` : "another run waits below its own"}`
          : yielded === "run" ? "another run has waited longer"
          : yielded === "priority" ? "a landing, base or verify gate of this run goes first"
          : yielded === "earlier" ? "an earlier wait of this run goes first"
          : `${limit(pool)} in use`;
        console.log(`  ${label}: waiting for a machine-wide ${pool} slot (${reason})`);
      }
      if (why !== told) {
        told = why;
        onWait?.(why!);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    endWait(wait);
  }
  const taken = slot;
  held.set(taken.file, taken.mine);
  if (keep) keeping++;
  let released = false;
  return await use({
    release() {
      if (released) return;
      released = true;
      if (keep) keeping--;
      held.delete(taken.file);
      releaseLock(taken.file, taken.mine);
    },
  });
}

/** Waits for a slot, runs `fn`, frees the slot. */
export const withSlot = async <T>(pool: PoolName, label: string, fn: () => Promise<T>, onWait?: (why: WaitReason) => void, pollMs = 5000, priority = false, keep = false): Promise<T> =>
  (await takeSlot(pool, label, onWait, pollMs, undefined, priority, keep, async (lease) => {
    try {
      return await fn();
    } finally {
      lease.release();
    }
  })) as T;

let extras = 0;

/**
 * Runs `fn` with an extra slot of `pool`: a lock outside the numbered ones
 * (`<pool>-extra-<run>-<n>.lock`, the content a slot has), taken at once and never waited for. It is
 * for a sandbox started inside a slot the caller already holds - the mid-run base check - which
 * would deadlock a pool of one if it waited, and was otherwise counted nowhere: other runs saw one
 * sandbox fewer than were alive. `usage()`, `liveSlots` and status.sh's `<pool>-*.lock` glob count
 * it; `tryAcquire` takes only numbered slots, so it blocks none. Accepted while it lives: `usage()`
 * can read 7/6, and as `members()` counts it in this run's `held`, this run's other tickets may wait
 * for their share. The share arithmetic stays as it is - hiding the slot from it would hide it from
 * the other runs too. Released when `fn` ends and at exit; one whose holder was killed counts for
 * nothing (`holderRunning`) and is removed by the next extra slot taken.
 */
export const withExtraSlot = async <T>(pool: PoolName, label: string, fn: () => Promise<T> | T): Promise<T> => {
  mkdirSync(DIR, { recursive: true });
  // The name is unique to this process, so a killed holder's lock is never taken over: it would stay for good.
  for (const f of readdirSync(DIR).filter((f) => f.includes("-extra-") && f.endsWith(".lock"))) {
    const content = read(join(DIR, f));
    if (content && !holderRunning(parseLock(content).pid)) rmSync(join(DIR, f), { force: true });
  }
  const file = join(DIR, `${pool}-extra-${RUN_ID}-${extras++}.lock`);
  const mine = `${process.pid} ${randomUUID()} run=${RUN_ID} ${label}\n`;
  writeFileSync(file, mine, { flag: "wx" });
  held.set(file, mine);
  try {
    return await fn();
  } finally {
    held.delete(file);
    releaseLock(file, mine);
  }
};

/** "sandboxes 3/6 · gates 1/2" - live slots only; read by status.sh too. */
export const usage = () => (["sandboxes", "gates"] as const).map((pool) => `${pool} ${liveSlots(pool).length}/${limit(pool)}`).join(" · ");

/** One live run's demand, share and cap, as `sandcastle cap` shows them. */
export type Standing = { project: string; demand: number; share: number; held: number; concurrency: number; cap?: number };

/** The live registered run of `project` with its file; no run, or several of one name, is a refusal. */
const runOf = (project: string, seen?: Seen) => {
  const live = registrations(seen).filter((r) => r.project === project);
  if (live.length === 0) throw new OperatorError(`No live sandcastle run of project "${project}". A cap is a live run's: it ends with the run.`);
  if (live.length > 1) throw new OperatorError(`${live.length} live runs are named "${project}" (pids ${live.map((r) => r.pid).join(", ")}): a cap cannot tell which you mean.`);
  return live[0]!;
};

/** The project's live run: what it wants, its share of the sandbox pool, what it holds and its cap. */
export const standing = (project: string): Standing => {
  const seen: Seen = new Map();
  const r = runOf(project, seen);
  const me = members("sandboxes", seen).find((m) => m.run === r.run);
  return { project, demand: r.demand, share: me?.share ?? 0, held: me?.held ?? 0, concurrency: r.concurrency, ...(r.cap ? { cap: r.cap } : {}) };
};

/** `sandcastle cap`'s arguments: an optional `--project <name>` and at most one of a whole number of 1 or more and `off`. */
export const parseCapArgs = (args: string[]): { project?: string; cap?: number | "off" } => {
  const rest = [...args];
  let project: string | undefined;
  const at = rest.indexOf("--project");
  if (at !== -1) {
    project = rest[at + 1];
    if (!project || project.startsWith("-")) throw new OperatorError("Usage: sandcastle cap [N | off] [--project NAME] - --project needs the project's name.");
    rest.splice(at, 2);
  }
  if (rest.length > 1) throw new OperatorError("Usage: sandcastle cap [N | off] [--project NAME]");
  const [given] = rest;
  if (given === undefined) return { project };
  if (given === "off") return { project, cap: "off" };
  if (!/^\d+$/.test(given) || Number(given) < 1) throw new OperatorError(`"${given}" is not a cap - expected a whole number of 1 or more, or "off".`);
  return { project, cap: Number(given) };
};

/**
 * Caps the project's live run's share at `cap` sandbox slots, or lifts the cap (`off`). The cap is
 * written into the run's registration, which the run reads before each slot request; it goes when
 * the run does.
 */
export const setCap = (project: string, cap: number | "off"): Standing => {
  const r = runOf(project);
  if (cap !== "off" && r.concurrency > 0 && cap > r.concurrency) {
    throw new OperatorError(`A cap of ${cap} is above this run's concurrency of ${r.concurrency}, the most it ever wants. Use ${r.concurrency} or fewer, or "off".`);
  }
  const { file, cap: _, ...registration } = r;
  writeFileWhole(file, { ...registration, ...(cap === "off" ? {} : { cap }) });
  return standing(project);
};

/** What `sandcastle cap` prints: the run's demand, share, what it holds and its cap. */
export const standingLine = (s: Standing) => `${s.project}: demand ${s.demand}, share ${s.share}, holds ${s.held}, cap ${s.cap ?? "off"}`;
