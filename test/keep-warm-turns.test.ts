// The cache refresh across the autonomy turns of one `sandcastle run` (mod/hooks/keep-warm.ts),
// pure: each turn writes a record with a new `startedAt`, and the run is still the same process.
// No Claude Code needed; the hook that calls it is tested in mod/tests/keep-warm.test.ts.
//
//   pnpm test:file test/keep-warm-turns.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../mod/hooks/run-state.ts";
import { activity, afterTurn, followRun, keepWarm, parseWarmth, settle, type Warmth } from "../mod/hooks/keep-warm.ts";

const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;
const at = (ms: number) => new Date(ms).toISOString();
const MISS = { isAnswered: true, usage: { cache_read_input_tokens: 0 } };

/** One look of the hook: follow the record, then ask the rule, as `warm()` does. */
const look = (kept: Warmth, run: Parameters<typeof followRun>[1], now: number) => {
  const memory = followRun(kept, run);
  return { memory, verdict: keepWarm({ live: true, lastActivity: activity(memory, memory.since), last: memory.last, misses: memory.misses, now }) };
};

test("a second turn of the same process does not push the refresh out", () => {
  // The session's last turn ended at T0; turn 1 started then, turn 2 fifty minutes later.
  let kept: Warmth = afterTurn({ misses: 0 }, T0);
  kept = look(kept, { pid: 42, startedAt: at(T0), turn: 1 }, T0 + 40 * MIN).memory;
  assert.equal(look(kept, { pid: 42, startedAt: at(T0), turn: 1 }, T0 + 40 * MIN).verdict.band, "cache refresh in 15m");
  const second = look(kept, { pid: 42, startedAt: at(T0 + 50 * MIN), turn: 2 }, T0 + 55 * MIN);
  assert.equal(second.verdict.refresh, true);
  assert.equal(second.memory.since, T0);
});

test("two misses over two turns of the same process turn the refresh off", () => {
  let kept: Warmth = look({ misses: 0 }, { pid: 42, startedAt: at(T0), turn: 1 }, T0).memory;
  kept = settle(kept, MISS, 150_000, T0 + 56 * MIN);
  assert.equal(kept.misses, 1);
  kept = afterTurn(kept, T0 + 57 * MIN);
  const turn2 = look(kept, { pid: 42, startedAt: at(T0 + 58 * MIN), turn: 2 }, T0 + 58 * MIN);
  assert.equal(turn2.memory.misses, 1);
  const again = settle(turn2.memory, MISS, 150_000, T0 + 115 * MIN);
  assert.equal(again.misses, 2);
  const turn3 = look(again, { pid: 42, startedAt: at(T0 + 120 * MIN), turn: 3 }, T0 + 180 * MIN);
  assert.equal(turn3.memory.misses, 2);
  assert.equal(turn3.verdict.mode, "off");
  assert.equal(turn3.verdict.refresh, false);
});

test("a record with a different pid starts the miss count over", () => {
  let kept: Warmth = look({ misses: 0 }, { pid: 42, startedAt: at(T0), turn: 1 }, T0).memory;
  kept = settle(kept, MISS, 150_000, T0 + 56 * MIN);
  const other = look(kept, { pid: 43, startedAt: at(T0 + 60 * MIN), turn: 2 }, T0 + 60 * MIN);
  assert.equal(other.memory.misses, 0);
  assert.equal(other.memory.last, undefined);
  assert.equal(other.memory.since, T0 + 60 * MIN);
});

test("a new record of turn 1 with the same pid is a new run", () => {
  let kept: Warmth = look({ misses: 0 }, { pid: 42, startedAt: at(T0), turn: 1 }, T0).memory;
  kept = settle(kept, MISS, 150_000, T0 + 56 * MIN);
  // The same record, looked at again, is still the same run.
  assert.equal(followRun(kept, { pid: 42, startedAt: at(T0), turn: 1 }).misses, 1);
  const reused = followRun(kept, { pid: 42, startedAt: at(T0 + 300 * MIN), turn: 1 });
  assert.equal(reused.misses, 0);
  assert.equal(reused.since, T0 + 300 * MIN);
});

test("two records with no pid and different startedAt are two runs; the same record is one", () => {
  let kept: Warmth = followRun({ misses: 0 }, { startedAt: at(T0) });
  kept = settle(kept, MISS, 150_000, T0 + 56 * MIN);
  assert.equal(followRun(kept, { startedAt: at(T0) }).misses, 1);
  assert.equal(followRun(kept, { startedAt: at(T0 + 50 * MIN), turn: 2 }).misses, 0);
});

test("the turn that ended last still counts when the run changes", () => {
  const kept = followRun(afterTurn({ misses: 0, run: "pid:42", since: T0 }, T0 + 10 * MIN), { pid: 43, startedAt: at(T0 + 20 * MIN), turn: 1 });
  assert.equal(kept.turnEnd, T0 + 10 * MIN);
});

test("what identifies a run survives a reload through parseWarmth", () => {
  const kept = followRun({ misses: 0 }, { pid: 42, startedAt: at(T0), turn: 1 });
  assert.deepEqual(parseWarmth(JSON.parse(JSON.stringify(kept))), kept);
  // A value an older mod stored (the run's startedAt, no floor) reads as another run, once.
  const old = parseWarmth({ run: at(T0), misses: 1 });
  assert.equal(followRun(old, { pid: 42, startedAt: at(T0), turn: 2 }).misses, 0);
});

test("the mod reads the record's turn and pid", () => {
  const run = parse(JSON.stringify({ pid: 42, startedAt: at(T0), settings: { turn: 2 } }));
  assert.equal(run?.turn, 2);
  assert.equal(run?.pid, 42);
  assert.equal(parse(JSON.stringify({ pid: 42, settings: { turn: "2" } }))?.turn, undefined);
  assert.equal(parse(JSON.stringify({ pid: 42 }))?.turn, undefined);
});
