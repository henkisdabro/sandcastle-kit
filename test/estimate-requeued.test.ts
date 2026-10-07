// A ticket implemented fresh and requeued after a conflict in the same run is a fresh ticket in the
// history; only the lines from its first resolve on price a carried branch (src/run.ts `estimate`).
// It used to count as carried whole, so a carried ticket was priced from the first attempt's whole
// cost. A ticket carried from an earlier run, with a resolve and no implement, is priced as before.
// Made-up timings; no tracker, Docker or network.
//
//   node --test test/estimate-requeued.test.ts

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
const tok = (input: number, output: number) => ({ input, cacheWrite: 0, cacheRead: 0, output });
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

/** Turn 1 of a ticket: a big implement, a review and gates, then a conflict: resolve, narrow review, gates, landing gates. */
const requeued = (issue: number) => [
  line({ issue: String(issue), phase: "implement", ms: 10 * MIN, tokens: tok(10_000_000, 100_000) }),
  line({ issue: String(issue), phase: "review", ms: 4 * MIN, tokens: tok(2_000_000, 20_000) }),
  line({ issue: String(issue), phase: "gates", ms: 2 * MIN }),
  line({ issue: String(issue), phase: "resolve", ms: 2 * MIN, tokens: tok(500_000, 5_000) }),
  line({ issue: String(issue), phase: "review", ms: 1 * MIN, tokens: tok(300_000, 3_000) }),
  line({ issue: String(issue), phase: "gates", ms: 2 * MIN }),
];

const project = (lines: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-requeued-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

test("a carried ticket is priced from a requeued ticket's resolve, review and gates, not its implement", () => {
  const p = project(requeued(1));
  // Resolve 2m + review 1m + gates 2m = 5m; 500k + 300k = 800k in, 8k out. The first attempt's 12.8M in / 21m is not it.
  assert.equal(
    estimate(p, 1, 1, 0, undefined, { carried: [true] })!,
    "Estimate (rough, from 1 ticket(s) in the last 3 runs): about 800k tokens in / 8k out and 5m for 1 ticket(s) (1 carried, 0 fresh), 1 at a time.",
  );
  // A fresh ticket is still priced from the whole history ticket: 12.8M in, 128k out, 21m.
  assert.match(estimate(p, 1, 1)!, /about 12\.8M tokens in \/ 128k out and 21m for 1 ticket\(s\), 1 at a time\.$/);
  // And the carried price is not a low one: the history had a carried sample.
  assert.ok(!/low/.test(estimate(p, 1, 1, 0, undefined, { carried: [true] })!));
});

test("a ticket carried from an earlier run, a resolve and no implement, is priced whole as before", () => {
  const p = project([
    line({ issue: "2", phase: "resolve", ms: 3 * MIN, tokens: tok(400_000, 4_000) }),
    line({ issue: "2", phase: "review", ms: 2 * MIN, tokens: tok(600_000, 6_000) }),
    line({ issue: "2", phase: "gates", ms: 2 * MIN }),
  ]);
  assert.equal(
    estimate(p, 1, 1, 0, undefined, { carried: [true] })!,
    "Estimate (rough, from 1 ticket(s) in the last 3 runs): about 1.0M tokens in / 10k out and 7m for 1 ticket(s) (1 carried, 0 fresh), 1 at a time.",
  );
});
