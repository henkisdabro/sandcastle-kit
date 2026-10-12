// What the run record keeps for the closing summary's account of a slow run: the time held below its ask beside another
// run (`sharedMs`), the time a worker waited for a sandbox slot (`sandboxWaitMs`), and the tests that went red and then green
// on a re-run (`flaky`). Made-up clock and output; `burndown()` needs Docker, so its call sites are held by their source.
//
//   pnpm test:file test/run-time-lost-recorded.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createSharedMeter, sharedBelowAsk } = await import("../src/pool.ts");
const { createSlotWaits } = await import("../src/burndown.ts");
const { flakyOf } = await import("../src/gates.ts");

const MIN = 60_000;

test("only time beside another run at a share under the ask counts as shared", () => {
  assert.equal(sharedBelowAsk({ demand: 3, share: 1 }, 1), true);
  assert.equal(sharedBelowAsk({ demand: 3, share: 3 }, 1), false);
  assert.equal(sharedBelowAsk({ demand: 3, share: 1 }, 0), false);
  assert.equal(sharedBelowAsk({ demand: 0, share: 0 }, 2), false);
});

test("the shared meter sums the stretches in which the run was held below its ask", () => {
  let t = 0;
  const meter = createSharedMeter(() => t);
  meter.sample(false);
  t = 10 * MIN;
  meter.sample(true); // another run arrives
  t = 70 * MIN;
  assert.equal(meter.ms(), 60 * MIN, "the open stretch counts up to now");
  meter.sample(false); // it ends
  t = 90 * MIN;
  meter.sample(true);
  t = 95 * MIN;
  assert.equal(meter.ms(), 65 * MIN);
});

test("the slot waits sum the time with a wait open once, however many workers wait side by side", () => {
  let t = 0;
  const waits = createSlotWaits(() => {}, () => t);
  const a = waits.begin();
  t = 5 * MIN;
  const b = waits.begin();
  t = 10 * MIN;
  a.end();
  assert.equal(waits.waitedMs, 10 * MIN, "b is still waiting");
  t = 12 * MIN;
  b.end();
  t = 30 * MIN;
  assert.equal(waits.waitedMs, 12 * MIN, "not the 17 minutes of the workers added up, and no time while none waits");
  const c = waits.begin();
  t = 33 * MIN;
  assert.equal(waits.waitedMs, 15 * MIN);
  c.end();
  c.end();
  assert.equal(waits.waitedMs, 15 * MIN, "a wait ended twice counts once");
});

test("a re-run's flake is the tests the red output named, else the gate", () => {
  const output = ["✖ failing tests:", "", "test at test/pool.test.ts:10:1", "✖ takes a slot (5ms)", "  Error: timed out"].join("\n");
  assert.deepEqual(flakyOf({ name: "test", output }), ["test/pool.test.ts::takes a slot"]);
  assert.deepEqual(flakyOf({ name: "lint", output: "something went wrong" }), ["lint"]);
});

test("burndown() records the shared time and the slot waits with the run, and a red-then-green re-run on its ticket", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /shared\.sample\(sharedBelowAsk\(mine, otherRuns\(\)\.length\)\)/);
  assert.match(src, /run\.finishWith\(\(\) => \{\s+const concurrency = load\.mean\(\);\s+return \{[^\n]*\.\.\.lostTimes\(\) \};/);
  assert.match(src, /sandboxWaitedMs = \(\) => slotWaits\.waitedMs/);
  assert.match(src, /run\.ticket\(issue\.id, \{ flaky: \[\.\.\.found\] \}\)/);
});
