// Run with `claude plugin test mod`: the idle mark's ready count - when the mod reads the queue,
// what it shares through the store, and that a read never holds up the session - with the clock,
// the process runner and the store answered by the test. No session, no model, no tracker.

import { expect, mock, test, type TestBody } from "claude-code/testing";

const T0 = 1_800_000_000_000;
const MIN = 60 * 1000;
const READY = (n: number) => `sandcastle · ${n} ready - /sandcastle run`;
const queue = (...rows: [string, string[]][]) => JSON.stringify(rows.map(([id, blockedOn]) => ({ id, title: `Ticket ${id}`, updated: null, blockedOn })));
const entry = (ageMin: number, ids: string[], ok = true, triedMin = ageMin) => ({ at: T0 - ageMin * MIN, ids, ok, tried: T0 - triedMin * MIN });
const RESULT = { stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
const START = { surface: "terminal", isInteractive: true, cwd: "/work" } as const;
const SKILL = { skill: "sandcastle", text: "the skill" };
const KEY = "ready:/work";

/** A set-up project with no run alive, a queue the test answers, and every read of it noted. */
const world = (on: Parameters<TestBody>[1], store: Record<string, unknown> = {}) => {
  const w = {
    clock: mock.clock(on, { now: T0 }),
    // What `queue --json` prints and exits with; `hang` holds the read that long, as a stuck tracker would.
    out: queue(["1", []], ["2", []], ["3", ["#1"]]),
    exit: 0,
    hang: 0,
    pid: false,
    reads: [] as { argv: readonly string[]; cwd?: string; timeoutMs?: number }[],
    statuses: [] as (string | undefined)[],
    store: new Map<string, unknown>(Object.entries(store)),
  };
  on("session.start", () => ({ cwd: "/work" }));
  on("classic.SessionStart", () => ({}));
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "session-1" }));
  on("fs.exists", () => ({ value: true }));
  on("fs.stat", ($, e) => ({ value: { kind: "file", size: 1, mtimeMs: 0, isLink: false, realPath: String(e.path) === "/kit/mod" ? "/kit/mod" : undefined } }));
  on("fs.read", () => ({ value: JSON.stringify({ orchestrator: "demo", pid: 42, startedAt: "2026-01-01T00:00:00.000Z", tickets: { 1: { state: "merged" } }, finishedAt: "2026-01-01T01:00:00.000Z", exitCode: 0 }) }));
  on("process.run", async ($, e) => {
    if (e.argv.includes("queue")) {
      w.reads.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs });
      if (w.hang) {
        // As the engine does: a child still running at its timeout is killed and the call rejects.
        const limit = e.init?.timeoutMs ?? 30000;
        await w.clock.sleep(Math.min(w.hang, limit));
        if (w.hang > limit) throw new Error(`timed out after ${limit} ms`);
      }
      return { value: { exitCode: w.exit, stdout: w.out, ...RESULT } };
    }
    // The settings script prints nothing; `ps` knows the run's process only while `pid` is set.
    const ps = e.argv[0] === "ps";
    return { value: { exitCode: ps && !w.pid ? 1 : 0, stdout: ps && w.pid ? "node --import /kit/node_modules/tsx/dist/loader.mjs /kit/src/cli.ts run\n" : "", ...RESULT } };
  });
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("store.get", ($, e) => ({ value: w.store.get(e.key) }));
  on("store.set", ($, e) => (w.store.set(e.key, e.value), { value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.status", ($, e) => (w.statuses.push(e.text), { value: undefined }));
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("skill.prompt", ($, e) => ({ text: e.text }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
  return w;
};

test("with no entry the first look reads the queue once, with the kit's own command, and the next look shows the count", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  await w.clock.settle();
  expect(w.reads.length).toBe(1);
  expect(w.reads[0]).toEqual({ argv: [expect.stringMatching(/\/bin\/sandcastle$|^sandcastle$/), "queue", "--json"], cwd: "/work", timeoutMs: 20000 });
  expect(w.store.get(KEY)).toEqual({ at: T0, ids: ["1", "2"], ok: true, tried: T0 });
  // The draw never waited for the read: the first line is the bare mark; the count is the next look's.
  expect(w.statuses).toEqual(["sandcastle"]);
  await w.clock.advance(15000);
  expect(w.statuses).toEqual(["sandcastle", READY(2)]);
  expect(w.reads.length).toBe(1);
});

test("a fresh entry in the shared store means no read, and shows its count at once", async ($, on) => {
  const w = world(on, { [KEY]: entry(3, ["1", "2", "3", "4"]) });
  await $.session.start(START);
  await w.clock.advance(5 * MIN);
  expect(w.reads.length).toBe(0);
  expect(w.statuses).toEqual([READY(4)]);
  // Ten minutes after it was read, one session's look reads it again.
  await w.clock.advance(5 * MIN);
  expect(w.reads.length).toBe(1);
});

test("a stale entry means one read when a session starts on it", async ($, on) => {
  const w = world(on, { [KEY]: entry(11, ["9"]) });
  await $.session.start(START);
  await w.clock.advance(5 * MIN);
  expect(w.reads.length).toBe(1);
  expect(w.store.get(KEY)).toEqual({ at: T0, ids: ["1", "2"], ok: true, tried: T0 });
});

test("the end of a run of this project triggers a read, though the entry is fresh", async ($, on) => {
  const w = world(on, { [KEY]: entry(1, ["1"]) });
  w.pid = true;
  await $.session.start(START);
  await w.clock.advance(60000);
  expect(w.reads.length).toBe(0);
  w.pid = false;
  await w.clock.advance(3000);
  await w.clock.settle();
  expect(w.reads.length).toBe(1);
  await w.clock.advance(15000);
  expect(w.statuses[w.statuses.length - 1]).toBe(READY(2));
});

test("using the skill triggers a read, though the entry is fresh", async ($, on) => {
  const w = world(on, { [KEY]: entry(1, ["1"]) });
  await $.session.start(START);
  expect(w.reads.length).toBe(0);
  await $.skill.prompt(SKILL);
  await w.clock.advance(15000);
  expect(w.reads.length).toBe(1);
});

test("a hung read is given up at its timeout, and holds up neither a redraw nor a second read", async ($, on) => {
  const w = world(on, { [KEY]: entry(30, ["1", "2"]) });
  w.hang = 10 * MIN;
  await $.session.start(START);
  await w.clock.settle();
  expect(w.reads.length).toBe(1);
  // While it hangs a run starts: the look finds it and the mark gives way to the band.
  w.pid = true;
  await w.clock.advance(15000);
  expect(w.statuses).toEqual([READY(2), undefined]);
  w.pid = false;
  await w.clock.advance(15000);
  // Still inside the 20 s: no second read is started beside it.
  expect(w.reads.length).toBe(1);
  await w.clock.advance(10000);
  // Timed out: the failure is recorded, the last good ids and their time kept.
  expect(w.store.get(KEY)).toEqual({ at: T0 - 30 * MIN, ids: ["1", "2"], ok: false, tried: T0 + 20000 });
});

test("a failed read keeps the last good count for an hour and then shows the bare mark, never an error", async ($, on) => {
  const w = world(on, { [KEY]: entry(20, ["1", "2"]) });
  w.exit = 1;
  w.out = "gh: not signed in";
  await $.session.start(START);
  await w.clock.settle();
  expect(w.reads.length).toBe(1);
  expect(w.store.get(KEY)).toEqual({ at: T0 - 20 * MIN, ids: ["1", "2"], ok: false, tried: T0 });
  expect(w.statuses).toEqual([READY(2)]);
  // Tried again every ten minutes, not at every look.
  await w.clock.advance(9 * MIN);
  expect(w.reads.length).toBe(1);
  await w.clock.advance(2 * MIN);
  expect(w.reads.length).toBe(2);
  // 20 minutes old at the start, so the hour is up 40 minutes in.
  await w.clock.advance(31 * MIN);
  expect(w.statuses[w.statuses.length - 1]).toBe("sandcastle");
  expect(w.statuses.every((s) => s === undefined || s.startsWith("sandcastle"))).toBe(true);
});

test("output that is no list of tickets is a failed read, never 0 ready", async ($, on) => {
  const w = world(on, { [KEY]: entry(20, ["1"]) });
  w.out = '{"error":"nope"}';
  await $.session.start(START);
  await w.clock.settle();
  expect(w.store.get(KEY)).toEqual({ at: T0 - 20 * MIN, ids: ["1"], ok: false, tried: T0 });
  expect(w.statuses).toEqual([READY(1)]);
});

test("a trigger that fires during a read gets one more read after it, and a look that is merely due does not", async ($, on) => {
  const w = world(on, { [KEY]: entry(30, ["1"]) });
  w.hang = 5000;
  await $.session.start(START);
  await w.clock.settle();
  // Looks while the read is out are due too, and add nothing.
  await w.clock.advance(3000);
  expect(w.reads.length).toBe(1);
  await $.skill.prompt(SKILL);
  await w.clock.advance(15000);
  expect(w.reads.length).toBe(2);
  await w.clock.advance(60000);
  expect(w.reads.length).toBe(2);
});
