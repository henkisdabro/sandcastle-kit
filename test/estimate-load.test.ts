// The run's estimate prices gate and landing-gate times from the earlier runs that ran at about this run's
// concurrency (their `load` in history.jsonl, within 1 of this run's), when the window holds two of them:
// a full queue's gates run slower than a small run's. With fewer it falls back to every run and says so.
// Made-up timings and history; no tracker, Docker or network.
//
//   node --test test/estimate-load.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tokens = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };

type Past = { concurrency?: number; gate: number; land: number };
/** One ticket per run, oldest first: a 5m implement, then `gate` minutes of gates and `land` minutes of landing gates; the history line says the run's concurrency, or nothing for an older kit's. */
const project = (runs: Past[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-load-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const stamp = (i: number) => `2026-01-0${i + 1}T00:00:00.000Z`;
  const timings = runs.flatMap((r, i) => {
    const line = (o: object) => JSON.stringify({ project: "fixture", run: stamp(i), issue: "1", ...o });
    return [line({ phase: "implement", ms: 5 * MIN, tokens }), line({ phase: "gates", ms: r.gate * MIN }), line({ phase: "landing gates", ms: r.land * MIN })];
  });
  const history = runs.map((r, i) => JSON.stringify({ startedAt: stamp(i), ...(r.concurrency === undefined ? {} : { load: { concurrency: r.concurrency, tickets: 1 } }) }));
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), timings.join("\n") + "\n");
  writeFileSync(join(root, ".sandcastle/logs/history.jsonl"), history.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

const FAST: Past = { concurrency: 2, gate: 1, land: 1 };
const SLOW: Past = { concurrency: 5, gate: 4, land: 3 };
// Three fast runs at 2 at a time, then two slow ones at 5: all five are in the window, and the median of all is a fast run's.
const mixed = () => project([FAST, FAST, FAST, SLOW, SLOW]);

/** The minutes of an estimate's time figure ("12m"), both ends of a range alike. */
const minutes = (text: string | undefined): number[] =>
  [...text!.match(/ and (.*?) for \d+ ticket/)![1].matchAll(/(?:(\d+)h )?(\d+)m/g)].map((m) => Number(m[1] ?? 0) * 60 + Number(m[2]));

const NOTE = /No history at \d+ at a time .*so it may be low\./;
// One gates slot: the gate passes' summed time sets the end, so the figure is the gate and landing-gate times themselves.
const gated = { gateSlots: 1 };

test("a run at 5 at a time is priced from the slow runs at that concurrency, not the fast small ones", () => {
  const text = estimate(mixed(), 4, 5, 0, undefined, gated);
  // 4 tickets x (4m gates + 3m landing gates) on one gates slot; the fast runs' median would give 4 x 2m.
  assert.deepEqual(minutes(text), [28]);
  assert.doesNotMatch(text!, NOTE);
});

test("a run at 2 at a time is priced from the fast runs, a slow queue's gate times not borrowed", () => {
  const text = estimate(mixed(), 4, 2, 0, undefined, gated);
  // Fast runs: 4 x 2m on the gates slot is 8m, below the sandboxes' 4 x 6m over 2 slots and its landing.
  assert.deepEqual(minutes(text), [13]);
  assert.doesNotMatch(text!, NOTE);
});

test("a concurrency one off is still of a similar load", () => {
  assert.deepEqual(minutes(estimate(mixed(), 4, 6, 0, undefined, gated)), [28]);
  assert.deepEqual(minutes(estimate(mixed(), 4, 4, 0, undefined, gated)), [28]);
});

test("one run at this concurrency is too few: every run prices the gates, and the line says it may be low", () => {
  const p = project([FAST, FAST, FAST, FAST, SLOW]);
  const text = estimate(p, 4, 5, 0, undefined, gated);
  // The fallback is today's pricing: the median of all five runs' gates (1m) and landing gates (1m), 4 x 2m.
  assert.equal(minutes(text)[0], 8);
  assert.match(text!, NOTE);
});

test("no run near this concurrency gives the fallback and the note", () => {
  const text = estimate(mixed(), 4, 12, 0, undefined, gated);
  assert.equal(minutes(text)[0], 8);
  assert.match(text!, /No history at 12 at a time/);
});

test("older history lines with no load are unknown: used in the fallback only", () => {
  const p = project([{ gate: 1, land: 1 }, { gate: 1, land: 1 }, { gate: 1, land: 1 }, { gate: 4, land: 3 }, { gate: 4, land: 3 }]);
  const text = estimate(p, 4, 5, 0, undefined, gated);
  assert.equal(minutes(text)[0], 8);
  assert.match(text!, NOTE);
});

test("a project with no history file at all gets the fallback and the note", () => {
  const p = mixed();
  writeFileSync(join(p.root, ".sandcastle/logs/history.jsonl"), "");
  const text = estimate(p, 4, 5, 0, undefined, gated);
  assert.equal(minutes(text)[0], 8);
  assert.match(text!, NOTE);
});
