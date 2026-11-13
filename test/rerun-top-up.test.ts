// A re-run turn at autonomy 2, 3 or `drain` tops the slots its re-runs leave free up with the tickets
// queued while the run was live, and the drain's stop rules keep judging the re-runs alone (#936).
// The loop in cli.ts has no harness, so this drives the pure pieces it is built from - the free
// slots, the late-ticket reader, the turn the stop rules judge and the start line - over a fake
// tracker and made-up facts, and holds the call sites by their source.
//
//   pnpm test:file test/rerun-top-up.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { afterTurn, drainStop, drainTurnOf, endOf, followOnTurn, lateTickets, NO_PROGRESS, rerunList, rerunStartLine, topUpSlots } = await import("../src/autonomy.ts");
const { refOf } = await import("../src/tracker.ts");
type Tracker = import("../src/tracker.ts").Tracker;
type Facts = Parameters<typeof afterTurn>[0];

const ticket = (id: string) => ({ id, title: `T${id}`, body: "", comments: [] });
const fake = (queue: string[]) => ({ ref: refOf, queued: () => queue.map(ticket) }) as unknown as Tracker;
const facts = (tickets: Facts["tickets"], runnable: string[] = []): Facts =>
  ({ base: "main", tracker: "github", started: "t", live: false, dryRun: false, verify: { green: true, line: "" }, gateCount: 1, tickets, runnable, blocked: [], standing: [], keptWorktrees: [], changed: {} }) as Facts;
const heldBy = (held: Record<string, string[]>) => async () => new Map(Object.entries(held));

/** The late tickets the loop tops a re-run turn up with: the free slots, then the reader, as cli.ts asks them. */
const topUp = async (o: { level: 0 | 1 | 2 | 3 | "drain"; effective: number; reruns: string[]; queue: string[]; held?: Record<string, string[]> }) =>
  (await lateTickets(fake(o.queue), new Set(o.reruns), heldBy(o.held ?? {}), undefined, topUpSlots(o.level, o.effective, o.reruns.length))).map((t) => t.id);

for (const level of [2, 3, "drain"] as const) {
  test(`level ${level}: a re-run turn tops its free slots up with late tickets, in queue order, up to the effective concurrency`, async () => {
    // 3 at a time, one re-run: two slots free, so #9 and #10 join and #11 waits.
    assert.deepEqual(await topUp({ level, effective: 3, reruns: ["1"], queue: ["1", "9", "10", "11"] }), ["9", "10"]);
    // 4 at a time, the same re-run: all three fit.
    assert.deepEqual(await topUp({ level, effective: 4, reruns: ["1"], queue: ["1", "9", "10", "11"] }), ["9", "10", "11"]);
  });
}

test("a turn whose re-runs fill every slot takes no late ticket", async () => {
  assert.equal(topUpSlots("drain", 2, 2), 0);
  assert.equal(topUpSlots("drain", 2, 3), 0);
  assert.deepEqual(await topUp({ level: "drain", effective: 2, reruns: ["1", "2"], queue: ["9"] }), []);
  assert.deepEqual(await topUp({ level: 3, effective: 2, reruns: ["1", "2", "3"], queue: ["9"] }), []);
});

test("levels 0 and 1 top nothing up: level 1 asks about the re-runs only", async () => {
  for (const level of [0, 1] as const) {
    assert.equal(topUpSlots(level, 4, 1), 0);
    assert.deepEqual(await topUp({ level, effective: 4, reruns: ["1"], queue: ["9", "10"] }), []);
  }
});

test("a held late ticket takes no free slot; one held only by a top-up ticket joins it as its dependant", async () => {
  // One free slot. #9 is held by an open blocker outside the run, so #10 takes the slot, and #11, held only by #10, joins it.
  assert.deepEqual(await topUp({ level: "drain", effective: 2, reruns: ["1"], queue: ["9", "10", "11", "12"], held: { 9: ["50"], 11: ["10"], 12: ["9"] } }), ["10", "11"]);
  // #11's blocker #12 is beyond the free slot: neither joins.
  assert.deepEqual(await topUp({ level: "drain", effective: 2, reruns: ["1"], queue: ["10", "11", "12"], held: { 11: ["12"] } }), ["10"]);
});

test("the turn's start line names the re-runs and the top-up apart, and is unchanged without a top-up", () => {
  const list = rerunList({ conflicted: ["1"], unblocked: [], unlanded: ["2"] }, refOf);
  assert.equal(
    rerunStartLine("drain", 2, list, ["#9", "#10"]),
    "Autonomy level drain: running again (turn 2 of at most 20): re-running #1, #2 (conflicted: #1; not landed: #2); topping up with #9, #10, queued after this run started.",
  );
  assert.equal(rerunStartLine(3, 2, list, []), "Autonomy level 3: running again (turn 2 of 3) for #1, #2 (conflicted: #1; not landed: #2).");
});

test("level 2: a top-up does not use up the run's one follow-on turn", async () => {
  // Turn 1 leaves #1 to run again; turn 2 re-runs it and tops up with #9.
  const turn1 = facts({ 1: { state: "conflict" } });
  assert.equal(afterTurn(turn1, 2, 1, () => true)?.verdict, "run");
  assert.deepEqual(await topUp({ level: 2, effective: 2, reruns: ["1"], queue: ["1", "9"] }), ["9"]);
  // Turn 2 lands both and #10 was queued during it: the follow-on turn is still there to take it.
  const turn2 = facts({ 1: { state: "merged" }, 9: { state: "merged" } });
  const late = (await lateTickets(fake(["10"]), new Set(["1", "9"]), heldBy({}))).map((t) => t.id);
  assert.deepEqual(late, ["10"]);
  assert.equal(followOnTurn({ level: 2, turn: 2, end: endOf(afterTurn(turn2, 2, 2, () => true)), late, followedOn: false }), true);
  // The loop has no harness: its source holds that only the follow-on decision sets `followedOn`.
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
  assert.equal(cli.match(/followedOn = true/g)?.length, 1);
  const followOn = cli.slice(cli.indexOf("const followOn = async"), cli.indexOf("// The no-PSI line"));
  assert.ok(followOn.includes("followedOn = true;"), "set in the follow-on decision alone");
});

test("drain: a turn whose re-run made no progress stops, though a top-up ticket landed", () => {
  // Turn 2 re-ran #1, red again, and topped up with #9, which landed.
  const turn2 = facts({ 1: { state: "red" }, 9: { state: "merged" } });
  const left = afterTurn(turn2, "drain", 2, () => true)!.left;
  const now = drainTurnOf({ facts: turn2, left, conflicted: [], before: [], topUp: new Set(["9"]) });
  assert.equal(now.landed, 0);
  assert.equal(drainStop(now, undefined), NO_PROGRESS);
  // The same turn with #9 a re-run of its own would have made progress.
  assert.equal(drainStop(drainTurnOf({ facts: turn2, left, conflicted: [], before: [], topUp: new Set() }), undefined), undefined);
});

test("drain: a ticket a top-up landing releases is no progress of the re-runs", () => {
  // #9 (top-up) landed and released #11, a top-up dependant; the re-run #1 is red.
  const turn2 = facts({ 1: { state: "red" }, 9: { state: "merged" }, 11: { state: "blocked" } }, ["11"]);
  const left = afterTurn(turn2, "drain", 2, () => true)!.left;
  assert.deepEqual(left.unblocked, ["11"]);
  assert.equal(drainStop(drainTurnOf({ facts: turn2, left, conflicted: [], before: [], topUp: new Set(["9", "11"]) }), undefined), NO_PROGRESS);
});

test("drain: a top-up ticket's failure is not a re-run's second failure, and it is compared from then on", () => {
  // Turn 2: re-run #1 lands; top-up #9 conflicts - a first-time failure, re-runnable next turn.
  const turn2 = facts({ 1: { state: "merged" }, 9: { state: "conflict" } });
  const after2 = afterTurn(turn2, "drain", 2, () => true)!;
  assert.deepEqual(after2.ids, ["9"]);
  const last2 = drainTurnOf({ facts: turn2, left: after2.left, conflicted: ["9"], before: [], topUp: new Set(["9"]) });
  assert.equal(drainStop(last2, undefined), undefined);
  assert.deepEqual(last2.conflicted, []);
  // Turn 3: #9 is a re-run now and conflicts again, beside #5, which lands: not two turns running as a re-run.
  const turn3 = facts({ 9: { state: "conflict" }, 5: { state: "merged" } });
  const after3 = afterTurn(turn3, "drain", 3, () => true)!;
  const last3 = drainTurnOf({ facts: turn3, left: after3.left, conflicted: ["9"], before: [], topUp: new Set() });
  assert.equal(drainStop(last3, last2, refOf), undefined);
  // Turn 4: #9 conflicts a second time as a re-run, beside a landing: the drain stops on it.
  const turn4 = facts({ 9: { state: "conflict" }, 6: { state: "merged" } });
  const after4 = afterTurn(turn4, "drain", 4, () => true)!;
  const last4 = drainTurnOf({ facts: turn4, left: after4.left, conflicted: ["9"], before: [], topUp: new Set() });
  assert.equal(drainStop(last4, last3, refOf), "#9 conflicted in two turns running");
});

test("the loop takes the top-up into the turn and judges the drain on the re-runs alone", () => {
  // The loop has no harness: its source holds where the top-up goes in and where it is left out.
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
  assert.match(cli, /topUpIds = \(await lateNow\(tracker, topUpSlots\(level, settings\.concurrency\.effective, ids\.length\)\)\)\.map\(\(t\) => t\.id\);/);
  assert.match(cli, /process\.env\.TICKETS = \[\.\.\.ids, \.\.\.topUpIds\]\.join\(","\);/);
  assert.match(cli, /toppedUp = new Set\(topUpIds\);/);
  assert.match(cli, /const now: DrainTurn = drainTurnOf\(\{ facts, left, conflicted: conflictedIn\(readOutcomes\(root\), facts\.started\), before: drain\.unblocked, topUp: toppedUp \}\);/);
  assert.match(cli, /console\.log\(rerunStartLine\(/);
});
