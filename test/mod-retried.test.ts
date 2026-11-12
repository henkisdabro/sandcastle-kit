// The Claude Code mod reads a ticket a later autonomy turn re-runs as not needing a person yet, as the status view does
// (`retriedNextTurn`, mod/hooks/run-record.ts), and only for a live run.

import assert from "node:assert/strict";
import { test } from "node:test";
import { line, needing, parse, rows, summarise, type Run } from "../mod/hooks/run-state.ts";

const record = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}): Run =>
  parse(
    JSON.stringify({
      pid: 1,
      settings: { autonomy: "drain", ...settings },
      tickets: { "7": { state: "not landed" }, "1": { state: "implement" }, "2": { state: "red" }, "3": { state: "merged" } },
      ...extra,
    }),
  )!;

test("a ticket the next turn re-runs is not raised as needing you", () => {
  const run = record({ turn: 2, cap: 20 });
  assert.deepEqual(needing(run), ["#2 gate red"]);
  assert.equal(summarise(run).counts[1], 1);
  const only = parse(JSON.stringify({ pid: 1, settings: { autonomy: "drain", turn: 2, cap: 20 }, tickets: { "7": { state: "not landed" } } }))!;
  assert.deepEqual(needing(only), []);
  assert.equal(summarise(only).counts[1], 0);
});

test("a ticket on the last turn still needs you", () => {
  const only = parse(JSON.stringify({ pid: 1, settings: { autonomy: "drain", turn: 20, cap: 20 }, tickets: { "7": { state: "not landed" } } }))!;
  assert.deepEqual(needing(only), ["#7 not landed"]);
  assert.equal(summarise(only).counts[1], 1);
});

test("a killed run's ticket reads needs you in /sandcastle-status's line, a live run's does not", () => {
  const run = record({ turn: 2, cap: 20 }, { tickets: { "7": { state: "not landed" } } });
  assert.match(line(run, false), /needs you/);
  assert.doesNotMatch(line(run, true), /needs you/);
});

test("the per-ticket lines order a re-run ticket with the later rows", () => {
  const run = record({ turn: 2, cap: 20 });
  assert.deepEqual(
    rows(run).map((r) => r.split(" ")[1]),
    ["#1", "#2", "#3", "#7"],
  );
  assert.deepEqual(
    rows(run, false).map((r) => r.split(" ")[1]),
    ["#1", "#2", "#7", "#3"],
  );
});

test("a dry run, a stop or a red base leave the ticket needing you", () => {
  for (const extra of [{ dryRun: true }, { stopped: true }, { verify: { green: false } }]) {
    assert.deepEqual(needing(record({ turn: 2, cap: 20 }, extra)), ["#2 gate red", "#7 not landed"], JSON.stringify(extra));
  }
  assert.deepEqual(needing(record({ turn: 2, cap: 20 }, { verify: { green: false, likelyLoad: true } })), ["#2 gate red"]);
});

test("a record with a cap that is no whole number keeps the ticket needing you", () => {
  assert.deepEqual(needing(record({ turn: 2, cap: "20" })), ["#2 gate red", "#7 not landed"]);
});
