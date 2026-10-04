// The run's estimate reads each ticket's implement model: an Opus ticket is estimated from earlier
// Opus tickets, not from the Sonnet ones that fill the window. Made-up timings; no tracker, Docker
// or network.
//
//   pnpm exec tsx --test test/estimate-model.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate } = await import("../src/run.ts");
const { IMPL_MODEL } = await import("../src/agents.ts");
type Project = Parameters<typeof estimate>[0];

const OPUS = "claude-opus-test";
const tok = (cacheRead: number, output: number) => ({ input: 0, cacheWrite: 0, cacheRead, output });
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

const project = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-model-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

// Ticket 1: default model, 10m and 1M in. Ticket 2: Opus, 40m and 8M in; its review line, first so that
// taking the first model seen would pick it, names another model.
// Ticket 3: a line from before models were recorded, so the default model.
const history = [
  line({ issue: "1", phase: "implement", ms: 600_000, model: IMPL_MODEL, tokens: tok(1_000_000, 10_000) }),
  line({ issue: "2", phase: "review", ms: 400_000, model: IMPL_MODEL, tokens: tok(0, 0) }),
  line({ issue: "2", phase: "implement", ms: 2_000_000, model: OPUS, tokens: tok(8_000_000, 80_000) }),
  line({ issue: "3", phase: "implement", ms: 600_000, tokens: tok(1_000_000, 10_000) }),
];

// The same, with more tickets of the same figures until each model has five (SOLID_HISTORY in src/run.ts):
// three more on the default model, four more on Opus.
const more = (issues: string[], model: string, ms: number, cacheRead: number) =>
  issues.map((issue) => line({ issue, phase: "implement", ms, model, tokens: tok(cacheRead, cacheRead / 100) }));
const solid = [...history, ...more(["4", "5", "6"], IMPL_MODEL, 600_000, 1_000_000), ...more(["7", "8", "9", "10"], OPUS, 2_000_000, 8_000_000)];

test("each ticket is estimated from the history of its own implement model", () => {
  const p = project(solid);
  // The summed 43m over 2 slots is 22m, but the Opus tickets' median is 33m (the 40m one carries a review line):
  // no run is shorter than its slowest ticket.
  assert.equal(
    estimate(p, 2, 2, 0, [IMPL_MODEL, OPUS]),
    "Estimate (rough, from 10 ticket(s) in the last 3 runs): about 9.0M tokens in / 90k out and 33m for 2 ticket(s), 2 at a time.",
  );
  // Without models the one median of all ten applies to both: the Opus tickets' figures, priced for the default-model ticket too.
  assert.match(estimate(p, 2, 2)!, /about 16\.0M tokens in \/ 160k out and 33m for 2 ticket\(s\)/);
});

test("a model with no history is estimated from all tickets, and the line says it is low", () => {
  const p = project(solid);
  const line = estimate(p, 3, 3, 0, [IMPL_MODEL, "claude-unseen", "claude-unseen"])!;
  assert.match(line, /about 17\.0M tokens in/);
  assert.match(line, /2 ticket\(s\) use a model with no history here; the estimate is low\.$/);
  assert.ok(!/no history/.test(estimate(p, 2, 2, 0, [IMPL_MODEL, OPUS])!));
});

test("a chain reads as tickets in sequence", () => {
  const p = project(solid);
  const text = estimate(p, 4, 4, 3, [IMPL_MODEL, IMPL_MODEL, IMPL_MODEL, IMPL_MODEL])!;
  assert.match(text, /4 at a time \(3 tickets in sequence\)\.$/);
  assert.ok(!/runs in order/.test(text));
});
