// A model with fewer than five tickets in the estimate's window is priced from its older tickets, outside the window, and the
// line says so; a model with history nowhere is still unknown. Made-up timings; no tracker, Docker or network.
//
//   pnpm test:file test/estimate-model-older.test.ts

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
const MIN = 60_000;
const runAt = (n: number) => `2026-09-${String(n).padStart(2, "0")}T10:00:00.000Z`;
const one = (run: number, issue: number, model: string, minutes: number, input: number) =>
  JSON.stringify({ project: "fixture", run: runAt(run), issue: String(issue), phase: "implement", ms: minutes * MIN, model, tokens: { input, cacheWrite: 0, cacheRead: 0, output: input / 100 } });

const project = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-older-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

// Runs 4, 5 and 6 are the window: two default-model tickets of 1M tokens in and 5m each. Run 1, one run outside it, has five
// Opus tickets of 8M and 40m, and run 2 a sixth that must not be reached (five is enough).
const history = () => [
  ...[4, 5, 6].flatMap((r) => [one(r, r * 10, IMPL_MODEL, 5, 1_000_000), one(r, r * 10 + 1, IMPL_MODEL, 5, 1_000_000)]),
  ...[1, 2, 3, 4, 5].map((n) => one(1, n, OPUS, 40, 8_000_000)),
  one(2, 9, OPUS, 90, 30_000_000),
];

test("a model outside the window is priced from its older runs, and the line says so", () => {
  const text = estimate(project(history()), 1, 1, 0, [OPUS])!;
  assert.match(text, /about 8\.0M tokens in \/ 80k out and 40m for 1 ticket\(s\)/, text);
  assert.ok(!/no history here/.test(text), text);
  assert.match(text, /claude-opus-test has too few tickets in the window: priced from older runs \(5 more tickets\)\./, text);
  // None of the window's tickets priced it; the five older ones did, and the count says so.
  assert.match(text, /from 0 ticket\(s\) in the last 3 runs and 5 older\)/, text);
});

test("the window's own model is priced as before, with nothing said about older runs", () => {
  const text = estimate(project(history()), 1, 1, 0, [IMPL_MODEL])!;
  assert.doesNotMatch(text, /older/, text);
});

test("a model with a ticket nowhere is still unknown", () => {
  const text = estimate(project(history()), 1, 1, 0, ["claude-unseen"])!;
  assert.match(text, /1 ticket\(s\) use a model with no history here; the estimate is low\./, text);
});
