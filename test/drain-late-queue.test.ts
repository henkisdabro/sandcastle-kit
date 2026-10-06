// A ticket queued while a `drain` run is live waits for the next `sandcastle run`: no turn takes
// it (a turn takes the last turn's re-runnable tickets only), and the closing lines name it.
// A fake tracker and made-up facts; no Docker, gh, model calls or network.
//
//   node --test test/drain-late-queue.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { afterTurn, lateQueueLines } = await import("../src/autonomy.ts");
const { refOf } = await import("../src/tracker.ts");
type Tracker = import("../src/tracker.ts").Tracker;
type Facts = Parameters<typeof afterTurn>[0];

const ticket = (id: string) => ({ id, title: `T${id}`, body: "", comments: [] });
const fake = (queue: () => string[]) => ({ ref: refOf, queued: () => queue().map(ticket) }) as unknown as Tracker;
const none = async () => new Set<string>();
const facts = (tickets: Facts["tickets"], runnable: string[]): Facts =>
  ({ base: "main", tracker: "github", started: "t", live: false, dryRun: false, verify: { green: true, line: "" }, gateCount: 1, tickets, runnable, blocked: [], standing: [], keptWorktrees: [], changed: {} }) as Facts;

test("a drain turn takes the last turn's re-runnable tickets, never one queued meanwhile", async () => {
  let queue = ["1", "2", "3"];
  const tracker = fake(() => queue);
  const inRun = new Set<string>();

  // Turn 1 ran #1, #2 and #3 (#3 blocked); #1 landed and unblocked #3.
  const turn1 = facts({ 1: { state: "merged" }, 2: { state: "red" }, 3: { state: "blocked" } }, ["3"]);
  for (const id of Object.keys(turn1.tickets)) inRun.add(id);
  queue = ["2", "3", "9"]; // #9 is queued while turn 1 ends
  const after = afterTurn(turn1, "drain", 1, () => true);
  assert.deepEqual(after?.ids, ["3"]);
  assert.equal(after?.verdict, "run");

  // Turn 2 lands #3; nothing is left to run again.
  const turn2 = facts({ 3: { state: "merged" } }, []);
  for (const id of Object.keys(turn2.tickets)) inRun.add(id);
  assert.equal(afterTurn(turn2, "drain", 2, () => true)?.verdict, "stop");

  assert.deepEqual(await lateQueueLines(tracker, inRun, none), ["#9 was queued after this run started: `sandcastle run` takes it"]);
});

test("lateQueueLines: one line per late ticket, none for a blocked one or when there is none", async () => {
  const tracker = fake(() => ["1", "7", "8"]);
  assert.deepEqual(await lateQueueLines(tracker, new Set(["1", "7", "8"]), none), []);
  assert.deepEqual(await lateQueueLines(tracker, new Set(["1"]), none), [
    "#7 was queued after this run started: `sandcastle run` takes it",
    "#8 was queued after this run started: `sandcastle run` takes it",
  ]);
  assert.deepEqual(await lateQueueLines(tracker, new Set(["1"]), async () => new Set(["7"])), ["#8 was queued after this run started: `sandcastle run` takes it"]);
});

test("lateQueueLines: an unreadable queue prints nothing", async () => {
  const tracker = { ref: refOf, queued: () => { throw new Error("gh failed"); } } as unknown as Tracker;
  assert.deepEqual(await lateQueueLines(tracker, new Set(), none), []);
});
