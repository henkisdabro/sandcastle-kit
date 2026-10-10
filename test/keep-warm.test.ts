// The cache refresh's rule (mod/hooks/keep-warm.ts), pure: when the session's prompt cache is
// refreshed while a run is live, and the row the band draws. No Claude Code needed; the hook that
// acts on it is tested in mod/tests/keep-warm.test.ts.
//
//   pnpm test:file test/keep-warm.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../mod/hooks/run-state.ts";
import { activity, afterTurn, INTERVAL_MS, keepWarm, parseWarmth, settle } from "../mod/hooks/keep-warm.ts";

const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;
const live = { live: true, lastActivity: T0, now: T0 };

test("the interval is 55 minutes, under the cache's hour", () => {
  assert.equal(INTERVAL_MS, 55 * MIN);
});

test("a refresh is due at 55 minutes of silence and not a millisecond before", () => {
  assert.deepEqual(keepWarm({ ...live, now: T0 + 55 * MIN - 1 }).refresh, false);
  const due = keepWarm({ ...live, now: T0 + 55 * MIN });
  assert.equal(due.refresh, true);
  assert.equal(due.mode, "1h");
  assert.equal(due.nextAt, T0 + 55 * MIN);
  assert.equal(keepWarm({ ...live, now: T0 + 3 * 60 * MIN }).refresh, true);
});

test("the band counts down to the next refresh in minutes, rounded up", () => {
  assert.equal(keepWarm({ ...live, now: T0 + 43 * MIN }).band, "cache warm · refresh in 12m");
  assert.equal(keepWarm({ ...live, now: T0 + 43 * MIN + 1 }).band, "cache warm · refresh in 12m");
  assert.equal(keepWarm({ ...live, now: T0 + 55 * MIN - 1 }).band, "cache warm · refresh in 1m");
});

test("after a refresh the band names its time and the tokens it read, and the next one is 55 minutes on", () => {
  const at = new Date(2026, 9, 10, 14, 2).getTime();
  const verdict = keepWarm({ live: true, lastActivity: at, last: { at, cacheRead: 157725, contextTokens: 157094 }, now: at + 2 * MIN });
  assert.equal(verdict.band, "cache refreshed 14:02 · 158k read");
  assert.equal(verdict.refresh, false);
  assert.equal(verdict.nextAt, at + 55 * MIN);
  const small = keepWarm({ live: true, lastActivity: at, last: { at, cacheRead: 900, contextTokens: 900 }, now: at });
  assert.equal(small.band, "cache refreshed 14:02 · 900 read");
});

test("a main-thread turn after a refresh puts the countdown back", () => {
  const verdict = keepWarm({ live: true, lastActivity: T0 + 10 * MIN, last: { at: T0, cacheRead: 100, contextTokens: 100 }, now: T0 + 20 * MIN });
  assert.equal(verdict.band, "cache warm · refresh in 45m");
});

test("disabled, or no live run: no refresh and no band", () => {
  const table = [
    { ...live, enabled: false, now: T0 + 90 * MIN },
    { ...live, live: false, now: T0 + 90 * MIN },
  ];
  for (const input of table) assert.deepEqual(keepWarm(input), { refresh: false, mode: "off" }, JSON.stringify(input));
});

test("a record with no keepWarm setting reads as on", () => {
  assert.equal(keepWarm({ ...live, enabled: undefined, now: T0 + 56 * MIN }).refresh, true);
  assert.equal(keepWarm({ ...live, enabled: true, now: T0 + 56 * MIN }).refresh, true);
});

test("overage means a 5-minute cache: no refresh however long the wait, and the band says why", () => {
  const verdict = keepWarm({ ...live, now: T0 + 3 * 60 * MIN, rateLimits: [{ percentUsed: 40 }, { percentUsed: 100 }] });
  assert.deepEqual(verdict, { refresh: false, mode: "5m", band: "cache 5m · not warmed (a cold restart costs less)" });
  assert.equal(keepWarm({ ...live, now: T0 + 3 * 60 * MIN, rateLimits: [{ percentUsed: 100.5 }] }).mode, "5m");
});

test("plan windows under 100% change nothing, and none at all assumes nothing", () => {
  assert.equal(keepWarm({ ...live, now: T0 + 56 * MIN, rateLimits: [{ percentUsed: 99.9 }, { percentUsed: 12 }] }).refresh, true);
  assert.equal(keepWarm({ ...live, now: T0 + 56 * MIN, rateLimits: [] }).refresh, true);
  assert.equal(keepWarm({ ...live, now: T0 + 56 * MIN }).refresh, true);
});

test("a refresh that read under half the context found the cache lapsed: 5-minute cache, no refresh", () => {
  const last = { at: T0, cacheRead: 40000, contextTokens: 100000 };
  const verdict = keepWarm({ live: true, lastActivity: T0, last, misses: 1, now: T0 + 2 * 60 * MIN });
  assert.equal(verdict.mode, "5m");
  assert.equal(verdict.refresh, false);
  // Exactly half is a hit.
  assert.equal(keepWarm({ live: true, lastActivity: T0, last: { ...last, cacheRead: 50000 }, now: T0 + MIN }).mode, "1h");
});

test("a turn after a miss clears it; the second miss in the run turns the refresh off for the run", () => {
  const hit = { isAnswered: true, usage: { cache_read_input_tokens: 157725 } };
  const miss = { isAnswered: true, usage: { cache_read_input_tokens: 0 } };
  let kept = settle({ misses: 0 }, miss, 150000, T0 + 55 * MIN);
  assert.equal(kept.misses, 1);
  assert.equal(keepWarm({ live: true, lastActivity: activity(kept), last: kept.last, misses: kept.misses, now: T0 + 3 * 60 * MIN }).mode, "5m");
  // A main-thread turn: the miss is cleared, and one more try comes at 55 minutes after the turn.
  kept = afterTurn(kept, T0 + 4 * 60 * MIN);
  assert.equal(kept.last, undefined);
  const again = keepWarm({ live: true, lastActivity: activity(kept), last: kept.last, misses: kept.misses, now: T0 + 4 * 60 * MIN + 55 * MIN });
  assert.equal(again.refresh, true);
  kept = settle(kept, miss, 150000, T0 + 5 * 60 * MIN);
  assert.equal(kept.misses, 2);
  assert.deepEqual(keepWarm({ live: true, lastActivity: activity(kept), last: kept.last, misses: kept.misses, now: T0 + 9 * 60 * MIN }), { refresh: false, mode: "off" });
  // A hit does not count, and a turn leaves it standing.
  const good = settle({ misses: 0 }, hit, 157094, T0);
  assert.equal(good.misses, 0);
  assert.deepEqual(afterTurn(good, T0 + MIN).last, good.last);
});

test("a refresh that was not answered is a miss, even with no context size known", () => {
  const kept = settle({ misses: 0 }, { isAnswered: false }, 0, T0);
  assert.equal(kept.misses, 1);
  assert.equal(keepWarm({ live: true, lastActivity: T0, last: kept.last, misses: kept.misses, now: T0 + MIN }).mode, "5m");
});

test("the last activity is the latest of a turn's end, a refresh and the run's start", () => {
  assert.equal(activity({ misses: 0 }), undefined);
  assert.equal(activity({ misses: 0 }, T0), T0);
  assert.equal(activity({ misses: 0, turnEnd: T0 + 5, last: { at: T0 + 9, cacheRead: 1, contextTokens: 1 } }, T0), T0 + 9);
  assert.equal(activity({ misses: 0, turnEnd: T0 + 20, last: { at: T0 + 9, cacheRead: 1, contextTokens: 1 } }), T0 + 20);
  assert.equal(activity({ misses: 0 }, Number.NaN), undefined);
});

test("parseWarmth reads what $.state holds and nothing else", () => {
  const kept = { run: "r", misses: 1, turnEnd: 5, last: { at: 1, cacheRead: 2, contextTokens: 3 } };
  assert.deepEqual(parseWarmth(kept), kept);
  for (const junk of [undefined, null, 4, "x", [], { misses: "1", last: { at: "1" }, turnEnd: Infinity }]) {
    assert.deepEqual(parseWarmth(junk), { misses: 0 }, JSON.stringify(junk));
  }
});

test("the run record's keepWarm setting is read as a boolean, and anything else as absent", () => {
  const keepWarmOf = (settings: unknown) => parse(JSON.stringify({ pid: 1, settings }))?.keepWarm;
  assert.equal(keepWarmOf({ keepWarm: false }), false);
  assert.equal(keepWarmOf({ keepWarm: true }), true);
  for (const settings of [{}, { keepWarm: "false" }, { keepWarm: 0 }, null, "x", undefined]) assert.equal(keepWarmOf(settings), undefined, JSON.stringify(settings));
});
