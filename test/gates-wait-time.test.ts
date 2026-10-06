// A gates step's recorded time is the gate run, not the wait for a machine-wide gates slot
// (`stepTimes` in src/gates.ts; `typicalTimes` and `estimate` in src/run.ts read the line's `ms`).
//
//   node --test test/gates-wait-time.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { runGates, stepTimes } = await import("../src/gates.ts");
const { typicalTimes } = await import("../src/run.ts");
type Project = Parameters<typeof typicalTimes>[0];

test("stepTimes takes the slot wait out of ms and records it as waitMs", () => {
  assert.deepEqual(stepTimes(640_000, { gates: [], waitMs: 411_000 }), { ms: 229_000, waitMs: 411_000 });
});

test("stepTimes leaves a step with no wait as it was", () => {
  assert.deepEqual(stepTimes(5_000, { gates: [], waitMs: 0 }), { ms: 5_000 });
  assert.deepEqual(stepTimes(5_000, { exitCode: 0 }), { ms: 5_000 });
  assert.deepEqual(stepTimes(5_000, undefined), { ms: 5_000 });
});

test("stepTimes never records a wait longer than the step", () => {
  assert.deepEqual(stepTimes(1_000, { waitMs: 9_000 }), { ms: 0, waitMs: 1_000 });
});

test("a gate run reports how long it waited for its slot, and not the gate's own time", async (t) => {
  // The clock is the one boundary here: it moves only when the fake gate takes its five seconds, so the
  // wait is exactly the time before the gate started (none, with no other run holding a slot) on any
  // machine. A bound on the real time the run took fails on a loaded one.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const project = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }] } as Parameters<typeof runGates>[0];
  const box = {
    exec: async (cmd: string) => {
      if (cmd.includes("run-lint")) t.mock.timers.tick(5_000);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const run = await runGates(project, box, "fixture gates");
  assert.equal(typeof run.waitMs, "number");
  assert.equal(run.gates[0].ms, 5_000, "the gate's own time is in its gate");
  assert.equal(run.waitMs, 0, "and out of the wait");
});

test("typicalTimes reads the run time of a gates line, not the wait", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = ["1", "2", "3"].map((issue) => ({ project: "fixture", run: "r1", issue, phase: "gates", ...stepTimes(640_000, { waitMs: 411_000 }) }));
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const typical = typicalTimes({ root, name: "fixture" } as Project);
  assert.equal(typical.gates, 229);
  assert.equal(typical.issue, 229);
});

// burndown's `timed` is too entangled with a live run to call; its wiring is held here instead.
test("a step's timings line and this run's usual issue time leave out the gates slot wait", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /times = stepTimes\(Date\.now\(\) - since, result\)/);
  assert.match(src, /phase, \.\.\.\(times \?\? \{ ms: Date\.now\(\) - since \}\), ok/);
  assert.match(src, /waited\.set\(issue, \(waited\.get\(issue\) \?\? 0\) \+ times\.waitMs\)/);
  assert.match(src, /typicalTimes\(project, \[\.\.\.took\]\.map\(\(\[id, ms\]\) => ms - \(waited\.get\(id\) \?\? 0\)\)\)/);
});
