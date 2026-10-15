// A run at autonomy 2, 3 or `drain` spends one more turn on the tickets queued while it was live
// (a follow-on turn); levels 0 and 1, and every stop that ends a run, take none. The loop in
// cli.ts has no harness, so this drives the pure decision and the late-ticket reader it is built
// from, replaying the loop's own sequence over a fake tracker and made-up facts.
//
//   pnpm test:file test/follow-on-turn.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { afterTurn, DRAIN_CAP, drainStop, endOf, endOfDrainStop, followOnTurn, lateQueueLines, lateTickets, noRerunCause } = await import("../src/autonomy.ts");
const { refOf } = await import("../src/tracker.ts");
type Tracker = import("../src/tracker.ts").Tracker;
type Facts = Parameters<typeof afterTurn>[0];
type DrainTurn = import("../src/autonomy.ts").DrainTurn;
type Level = Parameters<typeof followOnTurn>[0]["level"];

const ticket = (id: string) => ({ id, title: `T${id}`, body: "", comments: [] });
const fake = (queue: () => string[]) => ({ ref: refOf, queued: () => queue().map(ticket) }) as unknown as Tracker;
const none = async () => new Set<string>();
const facts = (tickets: Facts["tickets"], runnable: string[], over: Partial<Facts> = {}): Facts =>
  ({ base: "main", tracker: "github", started: "t", live: false, dryRun: false, verify: { green: true, line: "" }, gateCount: 1, tickets, runnable, blocked: [], standing: [], keptWorktrees: [], changed: {}, ...over }) as Facts;

/**
 * The loop's follow-on decision for a turn that ended with `turnFacts`: what cli.ts asks after
 * `afterTurn`, with the queue read through the real late-ticket reader.
 */
const decide = async (o: { level: Level; turn: number; turnFacts: Facts; queue: string[]; inRun: string[]; followedOn?: boolean; held?: string[] }) => {
  const after = afterTurn(o.turnFacts, o.level, o.turn, () => true);
  const late = (await lateTickets(fake(() => o.queue), new Set(o.inRun), async () => new Set(o.held ?? []))).map((t) => t.id);
  return followOnTurn({ level: o.level, turn: o.turn, end: endOf(after), late, followedOn: o.followedOn ?? false });
};

const landedAll = facts({ 1: { state: "merged" } }, []);

for (const level of ["drain", 2, 3] as const) {
  test(`level ${level}: a run with nothing left to run again takes a follow-on turn for a ticket queued meanwhile`, async () => {
    assert.equal(await decide({ level, turn: 1, turnFacts: landedAll, queue: ["9"], inRun: ["1"] }), true);
  });
}

test("level 2 at its own turn cap takes the follow-on turn, though tickets could still run again", async () => {
  const stillLeft = facts({ 1: { state: "merged" }, 2: { state: "blocked" } }, ["2"]);
  assert.equal(afterTurn(stillLeft, 2, 2, () => true)?.verdict, "cap");
  assert.equal(await decide({ level: 2, turn: 2, turnFacts: stillLeft, queue: ["9"], inRun: ["1", "2"] }), true);
  // Below the cap the loop simply runs again: no follow-on turn is asked for.
  assert.equal(await decide({ level: 2, turn: 1, turnFacts: stillLeft, queue: ["9"], inRun: ["1", "2"] }), false);
});

test("level 2 and 3: a ticket queued during the follow-on turn gets no second one and is named in the late lines", async () => {
  for (const level of [2, 3] as const) {
    const inRun = ["1", "9"];
    const turn2 = facts({ 9: { state: "merged" } }, []);
    // #10 was queued while follow-on turn 2 ran.
    assert.equal(await decide({ level, turn: 2, turnFacts: turn2, queue: ["10"], inRun, followedOn: true }), false);
    assert.deepEqual(await lateQueueLines(fake(() => ["10"]), new Set(inRun), none), ["#10 was queued after this run started: `sandcastle run` takes it"]);
  }
});

test("level 3: follow-on turn 2 runs #9, and #10 queued during it is left for the next run", async () => {
  const inRun = new Set<string>();
  let queue = ["1", "9"];
  let followedOn = false;
  const turn1 = facts({ 1: { state: "merged" } }, []);
  for (const id of Object.keys(turn1.tickets)) inRun.add(id);
  const late1 = (await lateTickets(fake(() => queue), new Set(["1", ...inRun]), none)).map((t) => t.id);
  assert.deepEqual(late1, ["9"]);
  assert.equal(followOnTurn({ level: 3, turn: 1, end: endOf(afterTurn(turn1, 3, 1, () => true)), late: late1, followedOn }), true);
  followedOn = true;

  const turn2 = facts({ 9: { state: "merged" } }, []);
  for (const id of Object.keys(turn2.tickets)) inRun.add(id);
  queue = ["10"];
  const late2 = (await lateTickets(fake(() => queue), new Set(["1", ...inRun]), none)).map((t) => t.id);
  assert.deepEqual(late2, ["10"]);
  assert.equal(followOnTurn({ level: 3, turn: 2, end: endOf(afterTurn(turn2, 3, 2, () => true)), late: late2, followedOn }), false);
  assert.deepEqual(await lateQueueLines(fake(() => queue), new Set(["1", ...inRun]), none), ["#10 was queued after this run started: `sandcastle run` takes it"]);
});

test("drain: a ticket queued during a follow-on turn earns another", async () => {
  assert.equal(await decide({ level: "drain", turn: 2, turnFacts: facts({ 9: { state: "merged" } }, []), queue: ["10"], inRun: ["1", "9"], followedOn: true }), true);
});

test("drain: a turn that ended on the no-progress stop still takes a follow-on turn for a late ticket", () => {
  // Turn 1: #1 is red and re-runnable as unlanded; it landed nothing and released nothing.
  const why = drainStop({ landed: 0, released: [], conflicted: [] }, undefined);
  assert.match(why ?? "", /^no progress/);
  assert.equal(endOfDrainStop(why!), "no progress");
  assert.equal(followOnTurn({ level: "drain", turn: 1, end: endOfDrainStop(why!), late: ["9"], followedOn: false }), true);
});

test("drain: turn 1 with every ticket red and nothing to retry takes a follow-on turn for #9", async () => {
  const red = facts({ 1: { state: "red" }, 2: { state: "red" } }, []);
  assert.equal(await decide({ level: "drain", turn: 1, turnFacts: red, queue: ["1", "2", "9"], inRun: ["1", "2"] }), true);
});

test("the other drain stops end the run: no follow-on turn for a late ticket", () => {
  const turn = (over: Partial<DrainTurn>): DrainTurn => ({ landed: 1, released: [], conflicted: [], ...over });
  for (const [now, earlier] of [
    [turn({ conflicted: ["1"] }), turn({ conflicted: ["1"] })],
    [turn({ partial: ["1"] }), turn({ partial: ["1"] })],
    [turn({ unlanded: ["1"] }), turn({ unlanded: ["1"] })],
  ]) {
    const why = drainStop(now, earlier);
    assert.ok(why, "a cause");
    assert.equal(endOfDrainStop(why), "stop");
    assert.equal(followOnTurn({ level: "drain", turn: 2, end: endOfDrainStop(why), late: ["9"], followedOn: false }), false);
  }
});

test("a late ticket held by an open blocker is not taken", async () => {
  assert.equal(await decide({ level: "drain", turn: 1, turnFacts: landedAll, queue: ["9"], inRun: ["1"], held: ["9"] }), false);
  // One unblocked beside it is enough.
  assert.equal(await decide({ level: "drain", turn: 1, turnFacts: landedAll, queue: ["9", "10"], inRun: ["1"], held: ["9"] }), true);
});

test("a ticket an earlier turn ran is never late", async () => {
  // #3 ran in turn 1 and is still queued (red): not late.
  assert.equal(await decide({ level: "drain", turn: 2, turnFacts: landedAll, queue: ["3"], inRun: ["1", "3"] }), false);
  assert.deepEqual((await lateTickets(fake(() => ["3", "9"]), new Set(["1", "3"]), none)).map((t) => t.id), ["9"]);
});

test("a ticket the run's start already queued is never late, and an unreadable queue means no follow-on turn", async () => {
  assert.deepEqual(await lateTickets(fake(() => ["5", "9"]), new Set(["5"]), none), [ticket("9")]);
  const broken = { ref: refOf, queued: () => { throw new Error("gh failed"); } } as unknown as Tracker;
  assert.deepEqual(await lateTickets(broken, new Set(), none), []);
});

test("a named run's scope leaves out a ticket the operator did not name", async () => {
  assert.deepEqual((await lateTickets(fake(() => ["8", "9"]), new Set(), none, new Set(["9"]))).map((t) => t.id), ["9"]);
});

test("levels 0 and 1 take no follow-on turn", async () => {
  for (const level of [0, 1] as const) {
    assert.equal(await decide({ level, turn: 1, turnFacts: landedAll, queue: ["9"], inRun: ["1"] }), false);
  }
});

test("a stop that ends the run takes no follow-on turn: dry run, stopped run, red base, usage limit", async () => {
  const causes: Facts[] = [
    facts({ 1: { state: "merged" } }, [], { dryRun: true }),
    facts({ 1: { state: "merged" } }, [], { stopped: "stopped by the operator" }),
    facts({ 1: { state: "merged" } }, [], { verify: { green: false, line: "red" } }),
    facts({ 1: { state: "merged" } }, [], { verify: { green: false, notRun: "no sandbox", line: "" } }),
    facts({ 1: { state: "merged" }, 2: { state: "skipped", note: "not started: usage limit" } }, []),
  ];
  let stops = 0;
  for (const turnFacts of causes) {
    assert.ok(noRerunCause(turnFacts), "a noRerunCause cause");
    stops++;
    for (const level of ["drain", 2, 3] as const) {
      assert.equal(afterTurn(turnFacts, level, 1, () => true), undefined);
      assert.equal(await decide({ level, turn: 1, turnFacts, queue: ["9"], inRun: ["1"] }), false);
    }
  }
  assert.equal(stops, 5);
});

test(`no follow-on turn once ${DRAIN_CAP} turns have run`, async () => {
  assert.equal(await decide({ level: "drain", turn: DRAIN_CAP, turnFacts: landedAll, queue: ["9"], inRun: ["1"] }), false);
  assert.equal(await decide({ level: "drain", turn: DRAIN_CAP - 1, turnFacts: landedAll, queue: ["9"], inRun: ["1"] }), true);
});
