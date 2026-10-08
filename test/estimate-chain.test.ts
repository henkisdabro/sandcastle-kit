// The run's estimate counts the in-run `Blocked by` chain: a chain runs one ticket after another,
// so its depth in tickets is its time when that is longer than the tickets' summed time over the slots. The depth comes from
// src/lint.ts, the code `queue --lint` prints its blocker depth from. Made-up timings and tickets
// (GitHub-style `#n` refs in the bodies); no tracker, Docker or network.
//
//   pnpm test:file test/estimate-chain.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing run.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate } = await import("../src/run.ts");
const { blockerChain } = await import("../src/lint.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = Parameters<typeof estimate>[0];

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-chain-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), JSON.stringify({ project: "fixture", run: "r1", issue: "1", phase: "implement", ms: 600_000, tokens }) + "\n");
  return { root, name: "fixture", tracker: fakeTracker() } as unknown as Project;
};
const tracker = { declaredBlockers: () => [] as string[] } as unknown as Parameters<typeof blockerChain>[1];

// 9 tickets: #1..#7 one chain, #8 and #9 free; a blocker outside the run (#99) orders nothing.
const nine = Array.from({ length: 9 }, (_, i) => ({ id: String(i + 1), body: i > 0 && i < 7 ? `Blocked by #${i}` : i === 8 ? "Blocked by #99" : "" }));

test("a chain of 7 among 9 tickets, 5 slots: the chain sets the time and the note", () => {
  const p = project();
  const chain = blockerChain(p, tracker, nine);
  assert.equal(chain.length, 7);
  assert.equal(
    estimate(p, 9, 5, chain.length)?.replace(/ No history at .*$/, ""),
    "Estimate (rough, from 1 ticket(s) in the last 3 runs): about 9.0M tokens in / 90k out and 1h 10m for 9 ticket(s), 5 at a time (7 tickets in sequence).",
  );
});

test("no chain: the figure is as before, and a blocker outside the run adds no time", () => {
  const p = project();
  const free = nine.map((t) => ({ ...t, body: t.id === "9" ? "Blocked by #99" : "" }));
  assert.equal(blockerChain(p, tracker, free).length, 1);
  const line = estimate(p, 9, 5, 1)!;
  assert.equal(line, estimate(p, 9, 5));
  assert.match(line, /and 18m for 9 ticket\(s\), 5 at a time\.(?: No history at .*)?$/);
});

test("a chain no longer than the summed tickets over slots sets nothing and says nothing", () => {
  const p = project();
  // 12 x 10m over 5 slots is 24m, longer than the 2-ticket chain's 20m.
  assert.match(estimate(p, 12, 5, 2)!, /24m for 12 ticket\(s\), 5 at a time\.(?: No history at .*)?$/);
});
