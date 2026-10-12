// A blocker chain's bound is its own tickets' prices: a chain of large tickets is bounded above a chain of small ones, because
// each is priced by its size (src/run.ts `sizeOf`) and not by the window's one typical time. Made-up timings; no tracker, Docker
// or network.
//
//   pnpm test:file test/estimate-chain-sizes.test.ts

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
const one = (issue: number, body: number, minutes: number) =>
  JSON.stringify({
    project: "fixture", run: "r1", issue: String(issue), phase: "implement", ms: minutes * MIN, touches: 0, bodyChars: body,
    tokens: { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 10_000 },
  });

// Three large tickets (30m) and three small ones (5m) in the window.
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-chain-sizes-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = [...[1, 2, 3].map((n) => one(n, 3000, 30)), ...[4, 5, 6].map((n) => one(n, 400, 5))];
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

const chain = (body: number) => estimate(project(), 3, 5, 3, undefined, { touches: [0, 0, 0], bodyChars: [body, body, body], chainAt: [0, 1, 2] })!;

test("a chain of three large tickets takes their summed 30m, a chain of three small ones their 5m", () => {
  const large = chain(3000);
  assert.match(large, /and 1h 30m for 3 ticket\(s\), 5 at a time \(3 tickets in sequence\)\./, large);
  const small = chain(400);
  assert.match(small, /and 15m for 3 ticket\(s\), 5 at a time \(3 tickets in sequence\)\./, small);
});

test("a chain mixing a large ticket with small ones is the sum of its own links", () => {
  const text = estimate(project(), 3, 5, 3, undefined, { touches: [0, 0, 0], bodyChars: [3000, 400, 400], chainAt: [0, 1, 2] })!;
  assert.match(text, /and 40m for 3 ticket\(s\)/, text);
});
