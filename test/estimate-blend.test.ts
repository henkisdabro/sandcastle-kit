// A model with fewer than five tickets in the window is not priced from them alone: two dear Opus tickets
// priced a four-Opus run at about twice what it took. Nor from all tickets alone, which priced it as the
// cheap model. Its figures are mixed with all tickets', weighted by its share of five, and the estimate
// line says so. Made-up timings; no tracker, Docker or network.
//
//   node --test test/estimate-blend.test.ts

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

const OPUS = "claude-opus-5-5";
const MIN = 60_000;
const line = (issue: string, model: string, ms: number, cacheRead: number) =>
  JSON.stringify({ project: "fixture", run: "r1", issue, phase: "implement", ms, model, tokens: { input: 0, cacheWrite: 0, cacheRead, output: cacheRead / 100 } });
const tickets = (from: number, n: number, model: string, ms: number, cacheRead: number) =>
  Array.from({ length: n }, (_, i) => line(String(from + i), model, ms, cacheRead));

const project = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-blend-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

// Twenty cheap default-model tickets (10m, 1M in) and two dear Opus ones (60m, 12M in).
const dear = [...tickets(1, 20, IMPL_MODEL, 10 * MIN, 1_000_000), ...tickets(21, 2, OPUS, 60 * MIN, 12_000_000)];

test("two dear Opus tickets in the history are blended with all tickets, and the line says so", () => {
  const text = estimate(project(dear), 4, 4, 0, [OPUS, OPUS, OPUS, OPUS])!;
  // Opus's own: 12M and 60m a ticket; all 22 tickets' median: 1M and 10m. Two of five parts its own,
  // three all tickets': 5.4M and 30m a ticket, so 21.6M for four - between 4M (all) and 48M (own).
  assert.match(text, /^Estimate \(rough, from 22 ticket\(s\) in the last 3 runs\): about 21\.6M tokens in \/ 216k out and 30m for 4 ticket\(s\), 4 at a time\./);
  assert.match(text, / claude-opus-5-5 from 2 tickets, blended\.(?: No history at .*)?$/);
});

test("a model with five tickets is priced from its own", () => {
  const text = estimate(project([...tickets(1, 20, IMPL_MODEL, 10 * MIN, 1_000_000), ...tickets(21, 5, OPUS, 60 * MIN, 12_000_000)]), 4, 4, 0, [OPUS, OPUS, OPUS, OPUS])!;
  assert.match(text, /about 48\.0M tokens in \/ 480k out and 1h 00m for 4 ticket\(s\)/);
  assert.ok(!/blended/.test(text));
});

test("one ticket reads in the singular, and each thin model is named once", () => {
  const text = estimate(project([...dear, line("23", "claude-haiku-fixture", 5 * MIN, 500_000)]), 3, 3, 0, [OPUS, "claude-haiku-fixture", OPUS])!;
  assert.match(text, / claude-opus-5-5 from 2 tickets, blended\. claude-haiku-fixture from 1 ticket, blended\.(?: No history at .*)?$/);
});

test("a model with no history at all still says the estimate is low", () => {
  const text = estimate(project(dear), 1, 1, 0, ["claude-unseen"])!;
  assert.match(text, /1 ticket\(s\) use a model with no history here; the estimate is low\.(?: No history at .*)?$/);
  assert.ok(!/blended/.test(text));
});
