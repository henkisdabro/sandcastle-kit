// A run at 2 slots or more never prices its landings from a run recorded at concurrency 1: there the base never moves under a
// branch, so every landing was a gate-free fast-forward, and at 2 or more nearly every landing after the first runs the gates.
// With no other history the run's landings are (tickets - 1) x the priced gate time; `typicalTimes` (the run record's `typical`,
// which the status view's end reads) applies the same filter. Made-up timings and history; no tracker, Docker or network.
//
//   pnpm test:file test/estimate-landing-load.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate, typicalTimes } = await import("../src/run.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tokens = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };

type Ticket = { model?: string; gate: number; implement?: number; land?: "merged" | "red"; landGates?: number };
type Past = { concurrency?: number; tickets: Ticket[] };

/** The runs, oldest first, each with its tickets: an implement line, a gates line, a landing line and, if the landing gated, a landing gates line. */
const project = (runs: Past[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-landing-load-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const stamp = (i: number) => `2026-01-0${i + 1}T00:00:00.000Z`;
  const timings = runs.flatMap((r, i) =>
    r.tickets.flatMap((t, n) => {
      const line = (o: object) => JSON.stringify({ project: "fixture", run: stamp(i), issue: String(n + 1), ...o });
      return [
        line({ phase: "implement", ms: (t.implement ?? 6) * MIN, tokens, ...(t.model ? { model: t.model } : {}) }),
        line({ phase: "gates", ms: t.gate * MIN }),
        ...(t.landGates === undefined ? [] : [line({ phase: "landing gates", ms: t.landGates * MIN })]),
        ...(t.land ? [line({ phase: "landing", ms: 1000, ok: t.land === "merged" })] : []),
      ];
    }),
  );
  const history = runs.map((r, i) => JSON.stringify({ startedAt: stamp(i), ...(r.concurrency === undefined ? {} : { load: { concurrency: r.concurrency, tickets: r.tickets.length } }) }));
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), timings.join("\n") + "\n");
  writeFileSync(join(root, ".sandcastle/logs/history.jsonl"), history.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

const minutes = (text: string | undefined): number[] =>
  [...text!.match(/ and (.*?) for \d+ ticket/)![1].matchAll(/(?:(\d+)h )?(\d+)m/g)].map((m) => Number(m[1] ?? 0) * 60 + Number(m[2]));

const gated = { gateSlots: 1 };
const GATE_BOUND = "(gate runs on 1 slot(s) set the time)";
const NO_HISTORY = /No history at 2 at a time/;

const merged = (gate: number, extra: Partial<Ticket> = {}): Ticket => ({ gate, land: "merged", ...extra });
/** Two runs at concurrency 1, two tickets each: a 6m implement, 5m of gates and a merged landing that ran no gates. */
const serial = (): Past[] => [{ concurrency: 1, tickets: [merged(5), merged(5)] }, { concurrency: 1, tickets: [merged(5), merged(5)] }];

test("a run at 2 at a time prices its landings after the first as its gate time, not from concurrency-1 fast-forwards", () => {
  const text = estimate(project(serial()), 4, 2, 0, undefined, gated);
  // 4 x 5m of gates and 3 x 5m of landing gates on the one gates slot.
  assert.deepEqual(minutes(text), [35]);
  assert.match(text!, new RegExp(GATE_BOUND.replace(/[()]/g, "\\$&")));
  assert.match(text!, NO_HISTORY);
});

test("the same history at 1 at a time keeps its fast-forward landings", () => {
  const text = estimate(project(serial()), 4, 1, 0, undefined, gated);
  assert.deepEqual(minutes(text), [44]);
  assert.doesNotMatch(text!, NO_HISTORY);
});

test("typicalTimes gives a run at 2 or more the gates figure for its landing gates, and the others today's 0", () => {
  const p = project(serial());
  assert.equal(typicalTimes(p, [], 2)["landing gates"], 300);
  assert.equal(typicalTimes(p, [], 4)["landing gates"], 300);
  assert.equal(typicalTimes(p)["landing gates"], 0);
  assert.equal(typicalTimes(p, [], 1)["landing gates"], 0);
});

test("a run at concurrency 2 whose landings gated prices a run at 2 from that figure", () => {
  const p = project([...serial(), { concurrency: 2, tickets: [merged(5, { landGates: 2 }), merged(5, { landGates: 2 })] }]);
  // 4 x 5m of gates and 4 x 2m of landing gates, not 3 x 5m.
  assert.deepEqual(minutes(estimate(p, 4, 2, 0, undefined, gated)), [28]);
  assert.equal(typicalTimes(p, [], 2)["landing gates"], 120);
});

test("every landing but the first costs its own ticket's priced gate time", () => {
  const ticket = (model: string, gate: number) => merged(gate, { model, implement: 1 });
  const run = (): Past => ({ concurrency: 1, tickets: [ticket("X", 5), ticket("Y", 3), ticket("X", 5), ticket("Y", 3), ticket("X", 5), ticket("Y", 3)] });
  const text = estimate(project([run(), run()]), 4, 2, 0, ["X", "Y", "X", "Y"], gated);
  // Gates 5 + 3 + 5 + 3, landings 3 + 5 + 3 (the first ticket, an X, lands free).
  assert.deepEqual(minutes(text), [27]);
});

test("each model's pool is priced alone: one with a gated landing uses it, one with only concurrency 1 uses the rule", () => {
  const x = (): Ticket => merged(5, { model: "X", implement: 1, landGates: 2 });
  const y = (): Ticket => merged(3, { model: "Y", implement: 1 });
  const p = project([
    { concurrency: 1, tickets: [y(), y(), y(), y(), y()] },
    { concurrency: 2, tickets: [x(), x(), x(), x(), x()] },
  ]);
  // Gates 5 + 3; landings X's 2 (its first ticket, no free landing: its figure is history's) and Y's own gate time, 3.
  assert.deepEqual(minutes(estimate(p, 2, 2, 0, ["X", "Y"], gated)), [13]);
});

test("a window whose only concurrency-2 run has no merged landing uses the rule", () => {
  const p = project([
    ...serial().slice(0, 1),
    { concurrency: 2, tickets: [{ gate: 5, land: "red", landGates: 2 }, { gate: 5, land: "red", landGates: 2 }] },
  ]);
  assert.deepEqual(minutes(estimate(p, 4, 2, 0, undefined, gated)), [35]);
});

test("a run with no recorded concurrency stays in the fallback for landings", () => {
  const p = project([{ tickets: [merged(5, { landGates: 2 }), merged(5, { landGates: 2 })] }, { tickets: [merged(5, { landGates: 2 }), merged(5, { landGates: 2 })] }]);
  assert.deepEqual(minutes(estimate(p, 4, 2, 0, undefined, gated)), [28]);
});

test("burndown() hands typicalTimes the run's slots wherever it writes the run record's typical", () => {
  // burndown() needs Docker, so no test drives it: without its slots, `typical` would price landings from concurrency-1 runs again.
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.equal(src.match(/typical: typicalTimes\(/g)?.length, 2);
  assert.equal(src.match(/typical: typicalTimes\([^\n]*, slots\)/g)?.length, 2);
});
