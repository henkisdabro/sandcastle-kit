// Which tickets a later autonomy turn will take by itself (`retriedNextTurn`, mod/hooks/run-record.ts): a forecast
// the status view, the Herdr app's root record and the tab bar read, so none says "needs you" before a person is needed.
//
//   pnpm test:file test/retried-next-turn.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { retriedNextTurn, UNCHECKED_NOTE, type RunRecord, type TicketRecord } from "../mod/hooks/run-record.ts";
import { nextTurn, rerunnable, turnCap, UNCHECKED_NOTE as AUTONOMY_UNCHECKED_NOTE, type Level } from "../src/autonomy.ts";
import type { Facts } from "../src/report.ts";

const tickets = (extra: Record<string, TicketRecord> = {}): Record<string, TicketRecord> => ({
  "7": { state: "not landed" },
  "8": { state: "conflict" },
  "9": { state: "red" },
  "10": { state: "held" },
  "11": { state: "uncommitted" },
  "12": { state: "crashed" },
  "13": { state: "stopped" },
  ...extra,
});
const record = (over: Partial<RunRecord> = {}, extra: Record<string, TicketRecord> = {}): RunRecord => ({
  settings: { autonomy: "drain", turn: 2, cap: 20 },
  ...over,
  tickets: tickets(extra),
});
const ids = (r: unknown, live = true) => [...retriedNextTurn(r, live)].sort();

test("a not landed or conflict ticket of a live run under its level's cap is retried next turn", () => {
  assert.deepEqual(ids(record()), ["7", "8"]);
  assert.deepEqual(ids(record({ settings: { autonomy: 2, turn: 1, cap: 2 } })), ["7", "8"]);
});

test("the last turn, level 0, level 1 and a follow-on past the cap retry nothing", () => {
  assert.deepEqual(ids(record({ settings: { autonomy: "drain", turn: 20, cap: 20 } })), []);
  assert.deepEqual(ids(record({ settings: { autonomy: 1, turn: 1 } })), []);
  assert.deepEqual(ids(record({ settings: { autonomy: 0, turn: 1, cap: 1 } })), []);
  assert.deepEqual(ids(record({ settings: { autonomy: 2, turn: 3 } })), []);
  assert.deepEqual(ids(record({ settings: undefined })), []);
  assert.deepEqual(ids(record({ settings: { autonomy: 3, turn: 1.5, cap: 3 } })), []);
});

test("a finished, stopped or dry run, a red base or a usage-limit skip retries nothing", () => {
  assert.deepEqual(ids(record({ finishedAt: "2027-01-15T07:00:00Z" })), []);
  assert.deepEqual(ids(record({ exitCode: 1 })), []);
  assert.deepEqual(ids(record({ stopped: "main moved" })), []);
  assert.deepEqual(ids(record({ dryRun: true })), []);
  assert.deepEqual(ids(record({ verify: { green: false, line: "red" } })), []);
  assert.deepEqual(ids(record({ verify: { green: false, line: "red", likelyLoad: true, notRun: "no sandbox" } })), []);
  assert.deepEqual(ids(record({}, { "14": { state: "skipped", note: "not started: usage limit" } })), []);
});

test("a red base judged load, or a ticket skipped for an unreadable edit read, still retries", () => {
  assert.deepEqual(ids(record({ verify: { green: false, line: "red", likelyLoad: true } })), ["7", "8"]);
  assert.deepEqual(ids(record({}, { "14": { state: "skipped", note: UNCHECKED_NOTE } })), ["7", "8"]);
});

test("a run that is not live retries nothing: no turn follows a killed run", () => {
  assert.deepEqual(ids(record(), false), []);
});

test("a record that is not an object, or has no tickets, retries nothing", () => {
  for (const r of [undefined, null, "x", 3, [], {}]) assert.deepEqual(ids(r), []);
});

test("the autonomy module's unchecked note is the record module's", () => {
  assert.equal(AUTONOMY_UNCHECKED_NOTE, UNCHECKED_NOTE);
});

test("at every level and turn the set is non-empty exactly when the autonomy loop would run another turn", () => {
  const levels: Level[] = [0, 1, 2, 3, "drain"];
  for (const level of levels) {
    const cap = turnCap(level);
    for (let turn = 1; turn <= (cap ?? 3) + 1; turn++) {
      // `settingsGroup`'s rule (src/run-settings.ts): no cap for level 1, nor for a turn past the level's cap.
      const settings = { autonomy: level, turn, ...(cap === undefined || turn > cap ? {} : { cap }) };
      const facts = { tickets: tickets(), runnable: [], partial: [] } as unknown as Facts;
      const again = rerunnable(facts);
      assert.equal(retriedNextTurn(record({ settings }), true).size > 0, nextTurn(level, turn, again) === "run", `level ${level}, turn ${turn}`);
    }
  }
});
