// The start line of a run that begins while another is live (src/pool.ts `startLines`,
// `splitAtStart`, `otherRuns`; src/run.ts `firstSlotWait`) and the estimate's divisor
// (`estimateSlots`): the other run's project, slots and demand, this run's share and a rough wait
// for its first slot, from made-up registrations and timings. An older kit's run is named as one
// that ignores shares; with no other run there is no line, and with no history no wait.
// Paths come from `node:path` and `os.tmpdir()`; nothing here calls a tool that differs between
// macOS and Linux except `ps`, through `kitLikeProcess`, which uses flags both share.
//
//   pnpm test:file test/start-split.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { kitLikeProcess } from "./kit-process.ts";

const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = cache;
process.env.SANDCASTLE_MAX_SANDBOXES = "6";
const { estimateSlots, otherRuns, recordOfRun, splitAtStart, startLines } = await import("../src/pool.ts");
const { estimate, firstSlotWait } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];
type Neighbour = Parameters<typeof startLines>[1][number];
type Member = Parameters<typeof splitAtStart>[1][number];

const slots = join(cache, "sandcastle-kit", "slots");
const runs = join(cache, "sandcastle-kit", "runs");
const kits: { kill: () => boolean }[] = [];
afterEach(() => {
  for (const k of kits.splice(0)) k.kill();
  rmSync(slots, { recursive: true, force: true });
  rmSync(runs, { recursive: true, force: true });
});
after(() => rmSync(cache, { recursive: true, force: true }));

const member = (o: Partial<Member>): Member => ({ run: "other", project: "webshop", pid: 1, demand: 5, held: 6, share: 3, registered: true, since: 1, ...o });
const other = (o: Partial<Neighbour> = {}): Neighbour => ({ project: "webshop", registered: true, held: 6, demand: 5, wait: 12 * 60, ...o });

test("the line names the other run, its slots and demand, this run's share and the wait for the first slot", () => {
  const others = [member({})];
  const split = splitAtStart(5, others);
  assert.deepEqual(split, { share: 3, free: 0 });
  assert.deepEqual(startLines(split, [other()]), [
    "webshop is live (6 slots, demand 5): this run's share is 3; it starts as webshop's tickets finish, the first likely in ~12m",
  ]);
});

test("the wait is left out when there is no history for it", () => {
  const [line] = startLines({ share: 3, free: 0 }, [other({ wait: undefined })]);
  assert.equal(line, "webshop is live (6 slots, demand 5): this run's share is 3; it starts as webshop's tickets finish");
  assert.doesNotMatch(line, /likely|~/);
});

test("an hour or more is said as the estimate says it", () => {
  assert.match(startLines({ share: 3, free: 0 }, [other({ wait: 65 * 60 })])[0], /the first likely in ~1h 05m$/);
});

test("some free slots: it starts with those and waits for the rest; enough free: it starts at once", () => {
  const some = startLines(splitAtStart(5, [member({ held: 4, demand: 5 })]), [other({ held: 4 })]);
  assert.equal(some[0], "webshop is live (4 slots, demand 5): this run's share is 3; it starts with 2 slots now and takes the rest as webshop's tickets finish, the first likely in ~12m");
  const one = startLines({ share: 3, free: 1 }, [other({ held: 5 })]);
  assert.match(one[0], /it starts with 1 slot now and takes the rest/);
  const plenty = startLines(splitAtStart(5, [member({ held: 1, demand: 1, share: 1 })]), [other({ held: 1, demand: 1 })]);
  assert.equal(plenty[0], "webshop is live (1 slot, demand 1): this run's share is 5; it starts at once");
});

test("two other runs are both named, and the first slot is the sooner wait", () => {
  const [line] = startLines({ share: 2, free: 0 }, [other({ held: 3, demand: 3, wait: 20 * 60 }), other({ project: "web", held: 3, demand: 4, wait: 7 * 60 })]);
  assert.equal(line, "webshop is live (3 slots, demand 3) and web is live (3 slots, demand 4): this run's share is 2; it starts as webshop's and web's tickets finish, the first likely in ~7m");
});

test("a run from an older kit is named as one that ignores shares, and does not stop the run starting", () => {
  assert.deepEqual(startLines({ share: 3, free: 0 }, [other({ registered: false, wait: undefined })]), ["webshop's run predates shares: it keeps taking free slots until it ends"]);
  assert.deepEqual(startLines({ share: 3, free: 0 }, [other({ registered: false, project: undefined })]), ["another project's run predates shares: it keeps taking free slots until it ends"]);
  const both = startLines({ share: 2, free: 0 }, [other({ project: "web", held: 3, demand: 3 }), other({ registered: false, held: 3 })]);
  assert.equal(both.length, 2);
  assert.match(both[0], /^web is live \(3 slots, demand 3\): this run's share is 2; it starts as web's and webshop's tickets finish/);
  assert.equal(both[1], "webshop's run predates shares: it keeps taking free slots until it ends");
});

test("no other live run: no line, and the share is the whole limit", () => {
  assert.deepEqual(startLines({ share: 5, free: 6 }, []), []);
  assert.deepEqual(splitAtStart(5, []), { share: 5, free: 6 });
});

// ---------------------------------------------------------------------------
// The other runs as the pool reads them: registrations and slot locks of processes that look like the kit.
// ---------------------------------------------------------------------------

const live = (run: string, project: string, demand: number, held: number, since: number) => {
  const kit = kitLikeProcess();
  kits.push(kit);
  mkdirSync(join(slots, "runs"), { recursive: true });
  writeFileSync(join(slots, "runs", `${run}.run`), JSON.stringify({ pid: kit.pid, run, project, demand, concurrency: demand, since, shares: true }) + "\n");
  for (let i = 0; i < held; i++) writeFileSync(join(slots, `sandboxes-${i + (run === "b" ? 3 : 0)}.lock`), `${kit.pid} token run=${run} ticket\n`);
  return kit;
};

test("otherRuns lists live runs that hold or want slots, and not a dead run's registration", () => {
  live("a", "alpha", 5, 3, 1);
  live("b", "beta", 0, 0, 2);
  const dead = kitLikeProcess();
  dead.kill();
  mkdirSync(join(slots, "runs"), { recursive: true });
  writeFileSync(join(slots, "runs", "dead.run"), JSON.stringify({ pid: dead.pid, run: "dead", project: "gone", demand: 5, concurrency: 5, since: 0, shares: true }) + "\n");
  const found = otherRuns();
  assert.deepEqual(found.map((m) => [m.project, m.demand, m.held]), [["alpha", 5, 3]], "beta wants and holds nothing");
  const split = splitAtStart(5, found);
  assert.deepEqual(split, { share: 3, free: 3 });
});

test("a live run with slots and no registration is an older kit's: counted, and told apart", () => {
  const kit = kitLikeProcess();
  kits.push(kit);
  mkdirSync(slots, { recursive: true });
  for (let i = 0; i < 6; i++) writeFileSync(join(slots, `sandboxes-${i}.lock`), `${kit.pid} token run=old ticket\n`);
  const found = otherRuns();
  assert.equal(found.length, 1);
  assert.equal(found[0].registered, false);
  assert.deepEqual(splitAtStart(5, found), { share: 3, free: 0 });
});

test("the record behind a live run is found by its pid through the live-runs directory", () => {
  const kit = kitLikeProcess();
  kits.push(kit);
  const root = mkdtempSync(join(tmpdir(), "sandcastle-root-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "webshop", pid: kit.pid, concurrency: 4 }));
  mkdirSync(join(cache, "sandcastle-kit", "runs"), { recursive: true });
  writeFileSync(join(cache, "sandcastle-kit", "runs", "abc"), root);
  assert.equal(recordOfRun(kit.pid)?.record.orchestrator, "webshop");
  assert.equal(recordOfRun(kit.pid)?.root, root);
  assert.equal(recordOfRun(kit.pid + 100000), undefined);
});

// ---------------------------------------------------------------------------
// The wait: the other project's usual time for an issue less its working tickets' ages.
// ---------------------------------------------------------------------------

const tok = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };
const timings = (lines: object[] | undefined): Project => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
  if (lines) {
    mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.map((l) => JSON.stringify({ project: "fixture", run: "r1", ...l })).join("\n") + "\n");
  }
  return { root, name: "fixture" } as Project;
};
// An issue takes 20 minutes here: 10 of implement and 10 of gates.
const history = [
  { issue: "1", phase: "implement", ms: 600_000, tokens: tok },
  { issue: "1", phase: "gates", ms: 600_000 },
];

test("the wait is the usual issue time less the oldest working ticket's age, a minute at least", () => {
  const project = timings(history);
  const now = 1_000_000_000_000;
  const at = (ageMin: number) => now / 1000 - ageMin * 60;
  const record = { tickets: { "1": { state: "implement" as const, started: at(5) }, "2": { state: "gates" as const, started: at(18) }, "3": { state: "queued" as const }, "4": { state: "landing" as const, started: at(1) } } };
  assert.equal(firstSlotWait(project, record, now), 120, "20 minutes less the oldest ticket's 18; the queued and the landing ticket hold no slot to free");
  assert.equal(firstSlotWait(project, { tickets: { "1": { state: "implement", started: at(40) } } }, now), 60, "overdue: a minute at least, as the status view counts it");
  assert.equal(firstSlotWait(project, { tickets: { "1": { state: "resolve", started: at(40), attemptStarted: at(5) } } }, now), 900, "a requeued second attempt counts from its own start");
});

test("no history, or no working ticket: no wait", () => {
  const now = Date.now();
  const working = { tickets: { "1": { state: "implement" as const, started: now / 1000 - 60 } } };
  assert.equal(firstSlotWait(timings(undefined), working, now), undefined);
  assert.equal(firstSlotWait(timings([{ issue: "0", phase: "base-gates", ms: 999_999 }]), working, now), undefined, "steps before the agents are no issue");
  assert.equal(firstSlotWait(timings(history), { tickets: { "1": { state: "queued" } } }, now), undefined);
  assert.equal(firstSlotWait(timings(history), {}, now), undefined);
});

// ---------------------------------------------------------------------------
// The estimate divides by the run's share when another run is live, the machine limit otherwise.
// ---------------------------------------------------------------------------

test("the estimate's divisor is the share when another run is live, and the machine limit otherwise", () => {
  assert.equal(estimateSlots(5, undefined), 5, "alone: the workers, within the limit");
  assert.equal(estimateSlots(9, undefined), 6, "alone: never above the machine limit");
  assert.equal(estimateSlots(5, splitAtStart(5, [member({})])), 3, "another run live: the share");
  assert.equal(estimateSlots(2, splitAtStart(2, [member({})])), 2, "a run that wants less than its share uses what it wants");

  const project = timings([...history, { issue: "2", phase: "implement", ms: 600_000, tokens: tok }, { issue: "2", phase: "gates", ms: 600_000 }]);
  const tickets = 6;
  const alone = estimate(project, tickets, estimateSlots(6, undefined));
  const shared = estimate(project, tickets, estimateSlots(6, splitAtStart(6, [member({})])));
  assert.match(alone!, /for 6 ticket\(s\), 6 at a time/);
  assert.match(shared!, /for 6 ticket\(s\), 3 at a time/);
  assert.match(alone!, /\b20m for/, "one round of 20 minutes");
  assert.match(shared!, /\b40m for/, "two rounds of 20 minutes");
});
