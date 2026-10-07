// What the pool tests (pool-shares, pool-cap) drive src/pool.ts with: this process is one run, the
// other runs are files - a registration, slot locks and wait entries a made-up pid owns - written
// the way the pool writes them, and `inject` answers the pool's "is that pid the kit" for all of
// them. No child process polls in real time: a ticket asks again every POLL ms, and a test changes
// another run's files by hand at the instant it wants to look at what this run does.
//
// Import it before anything from src/: it points the pool at a temp directory first. A test file
// calls `afterEach(cleanup)`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { everyPidIsTheKit } from "./kit-process.ts";

export const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = cache;
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-config-"));
process.env.SANDCASTLE_MAX_SANDBOXES = "6";
process.env.SANDCASTLE_MAX_GATES = "1";
export const pool = await import("../src/pool.ts");
const { RUN_ID, slotsByRun, withSlot } = pool;
export { RUN_ID };

export const slots = join(cache, "sandcastle-kit", "slots");
export const registrations = join(slots, "runs");
const waits = join(slots, "waits");

/** How often a ticket looks again: the poll interval a real run leaves at 5 s. */
export const POLL = 2;

/** Pids that are gone: everything else, this process and the made-up runs' pids alike, is a process of the kit. */
const gone = new Set<number>();
pool.inject({ probe: (pid) => (gone.has(pid) ? undefined : everyPidIsTheKit()) });

/** A pid that is not a process, as `holderRunning` finds it. */
export const deadPid = () => {
  const { pid } = spawnSync("true");
  gone.add(pid!);
  return pid!;
};

// withSlot says why it waits on the console: kept here, so a green suite prints nothing of its own.
export const said: string[] = [];
console.log = (...args: unknown[]) => void said.push(args.join(" "));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Returns at the first look that holds. */
export const until = async (ok: () => boolean, what = "the condition") => {
  for (let i = 0; i < 1000; i++) {
    if (ok()) return;
    await sleep(POLL);
  }
  assert.fail(`timed out waiting for ${what}`);
};
/** The condition holds at every look for `ms` (some 50 polls of a waiting ticket): a slot nobody should take stays free. */
export const steady = async (ok: () => boolean, what: string, ms = 100) => {
  for (let t = 0; t < ms; t += 5) {
    assert.ok(ok(), `${what}, at ${t} ms: held ${heldBy()}`);
    await sleep(5);
  }
};

/** The slots each live run holds, as numbers in order: "3,3". */
export const heldBy = () => [...slotsByRun("sandboxes").values()].sort().join();
/** The slots this run holds. */
export const mine = () => slotsByRun("sandboxes").get(RUN_ID) ?? 0;

const tickets: Ticket[] = [];
type Ticket = { taken: boolean; why: string[]; release: () => void; done: Promise<void> };

/**
 * One of this run's tickets: asks for a sandbox slot, and holds it until `release()`. `keep` is a ticket pipeline's
 * lease in a run that lands (it leaves a slot of the share to landing), `priority` a landing's.
 */
export const ticket = (label: string, o: { keep?: boolean; priority?: boolean } = {}): Ticket => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t: Ticket = { taken: false, why: [], release, done: undefined as never };
  t.done = withSlot("sandboxes", label, async () => {
    t.taken = true;
    await gate;
  }, (why) => t.why.push(why), POLL, o.priority ?? false, o.keep ?? false);
  t.done.catch(() => {});
  tickets.push(t);
  return t;
};
/** `n` tickets of this run. */
export const tix = (label: string, n: number) => Array.from({ length: n }, (_, i) => ticket(`${label}${i}`));

const pids = new Map<string, number>();
let nextPid = 1_000_000;
const pidOf = (run: string) => {
  if (!pids.has(run)) pids.set(run, nextPid++);
  return pids.get(run)!;
};
const lockOf = (run: string) => (f: string) => f.endsWith(".lock") && readFileSync(join(slots, f), "utf8").includes(` run=${run} `);

/** Gives `run` exactly `n` slot locks, the way a run holding `n` slots looks to the pool. */
export const setHeld = (run: string, n: number) => {
  mkdirSync(slots, { recursive: true });
  let files = readdirSync(slots).filter(lockOf(run));
  for (const f of files.slice(n)) rmSync(join(slots, f));
  files = files.slice(0, n);
  while (files.length < n) {
    const free = Array.from({ length: 6 }, (_, i) => `sandboxes-${i}.lock`).find((f) => !existsSync(join(slots, f)));
    assert.ok(free, `a free slot for ${run}`);
    writeFileSync(join(slots, free), `${pidOf(run)} token-${run}-${files.length} run=${run} a ticket\n`);
    files.push(free);
  }
};

export type Other = { project?: string; demand: number; held?: number; since?: number; cap?: number; concurrency?: number; pid?: number };
/** Another live run: its registration, written whole as the pool writes one, and the slots it holds. Again with new values to change it. */
export const other = (run: string, o: Other) => {
  mkdirSync(registrations, { recursive: true });
  const { pid = pidOf(run), project = run, demand, since = Date.now(), concurrency = demand, cap } = o;
  writeFileSync(join(registrations, `${run}.run`), JSON.stringify({ pid, run, project, demand, concurrency, since, shares: true, ...(cap ? { cap } : {}) }) + "\n");
  if (o.held !== undefined) setHeld(run, o.held);
};
/** A wait entry of another run, `since` ms since the epoch. */
export const waiting = (run: string, since: number) => {
  mkdirSync(waits, { recursive: true });
  writeFileSync(join(waits, `sandboxes-${since}-${run}-0.wait`), `${pidOf(run)} ${run} ${since} a ticket\n`);
};
/** Another run ends: its slots, registration and waits go. */
export const end = (run: string) => {
  setHeld(run, 0);
  rmSync(join(registrations, `${run}.run`), { force: true });
  for (const f of existsSync(waits) ? readdirSync(waits) : []) if (f.includes(`-${run}-`)) rmSync(join(waits, f));
};

/** After each test: this run's tickets finish, and the pool's files go, so the next test starts alone. */
export const cleanup = async () => {
  for (const t of tickets) t.release();
  rmSync(slots, { recursive: true, force: true });
  await Promise.allSettled(tickets.splice(0).map((t) => t.done));
  rmSync(slots, { recursive: true, force: true });
  said.length = 0;
};
