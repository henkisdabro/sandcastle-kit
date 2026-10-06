// The run's estimate counts the machine's gates pool: every ticket's gate passes share `maxGates`
// slots, so a large run on few of them takes at least their summed time over those slots, whatever
// the sandboxes. The larger of that and the sandbox-bound figure sets the time. Made-up timings; no
// tracker, Docker or network.
//
//   node --test test/estimate-gates.test.ts

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
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

// Three tickets of 10 minutes each: 4 minutes of agent work and two gate passes of 3 minutes.
const project = (extra: string[] = []) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-gates-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = ["1", "2", "3"].flatMap((issue) => [
    line({ issue, phase: "implement", ms: 4 * MIN, tokens }),
    line({ issue, phase: "gates", ms: 3 * MIN, waitMs: 20 * MIN }),
    line({ issue, phase: "gates", ms: 3 * MIN }),
  ]);
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), [...lines, ...extra].join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

test("18 tickets on 2 gate slots: gate runs set the time, above the sandbox-only figure", () => {
  const p = project();
  // Sandbox-bound: 18 x 10m over 9 slots is 20m. Gate-bound: 18 x 6m over 2 slots is 54m.
  assert.match(estimate(p, 18, 9)!, /and 20m for 18 ticket\(s\), 9 at a time\.$/);
  assert.match(estimate(p, 18, 9, 0, undefined, { gateSlots: 100 })!, /and 20m for 18 ticket\(s\), 9 at a time\.$/);
  assert.match(estimate(p, 18, 9, 0, undefined, { gateSlots: 2 })!, /and 54m for 18 ticket\(s\), 9 at a time \(gate runs on 2 slot\(s\) set the time\)\.$/);
});

test("the slot wait is not gate time, so it is not counted twice", () => {
  const p = project();
  // 3 tickets x 6m over 1 slot is 18m, not the 40m+ the recorded waits would add.
  assert.match(estimate(p, 3, 3, 0, undefined, { gateSlots: 1 })!, /and 18m for 3 ticket\(s\), 3 at a time \(gate runs/);
});

test("enough gate slots, or a history with no gate lines: the figure and the line are as before", () => {
  const p = project();
  assert.equal(estimate(p, 18, 9, 0, undefined, { gateSlots: 18 }), estimate(p, 18, 9));
  const bare = (() => {
    const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-gates-"));
    mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
    writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), line({ issue: "1", phase: "implement", ms: 10 * MIN, tokens }) + "\n");
    return { root, name: "fixture" } as Project;
  })();
  assert.equal(estimate(bare, 18, 9, 0, undefined, { gateSlots: 1 }), estimate(bare, 18, 9));
});
