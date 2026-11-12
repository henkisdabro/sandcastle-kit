// The start line's head names where the sandbox cap comes from, before the colon that introduces the ticket list,
// and says gate passes run beside the workers (src/pool.ts `limitWithSource`, src/landing.ts `landingSlotNote`,
// src/burndown.ts `startHeadLine`). Expected text is the ticket's own, worked by hand. No Docker, no model.
//
//   pnpm test:file test/start-line-pool-source.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const { limitWithSource } = await import("../src/pool.ts");
const { landingSlotNote } = await import("../src/landing.ts");
const { startHeadLine } = await import("../src/burndown.ts");

test("a pool's limit says whether the environment, the machine settings or the default gave it", () => {
  assert.deepEqual(limitWithSource("sandboxes", {}, { maxSandboxes: 3 }), { value: 3, source: "config", name: "maxSandboxes" });
  assert.deepEqual(limitWithSource("sandboxes", { SANDCASTLE_MAX_SANDBOXES: "4" }, { maxSandboxes: 3 }), { value: 4, source: "env", name: "SANDCASTLE_MAX_SANDBOXES" });
  assert.deepEqual(limitWithSource("sandboxes", {}, {}), { value: 6, source: "default", name: "maxSandboxes" });
  assert.deepEqual(limitWithSource("gates", {}, {}), { value: 2, source: "default", name: "maxGates" });
  assert.deepEqual(limitWithSource("gates", { SANDCASTLE_MAX_GATES: "1" }, {}), { value: 1, source: "env", name: "SANDCASTLE_MAX_GATES" });
});

test("the note on the kept slot names the setting that holds the pool and points at sandcastle size", () => {
  assert.equal(landingSlotNote(3, false, { source: "config", name: "maxSandboxes" }), "maxSandboxes is 3 (machine settings) and one slot is kept for landing - `sandcastle size` suggests a figure");
  assert.equal(landingSlotNote(3, false, { source: "env", name: "SANDCASTLE_MAX_SANDBOXES" }), "SANDCASTLE_MAX_SANDBOXES is 3 and one slot is kept for landing - `sandcastle size` suggests a figure");
  assert.equal(landingSlotNote(3, false, { source: "default", name: "maxSandboxes" }), "the default pool is 3 sandboxes and one slot is kept for landing - `sandcastle size` suggests a figure");
  assert.equal(
    landingSlotNote(3, true, { source: "config", name: "maxSandboxes" }),
    "maxSandboxes is 3 (machine settings) and one slot is kept for landing - beside another run, for any run's landing, outside every run's share - `sandcastle size` suggests a figure",
  );
});

test("without a source the note is the one earlier kits printed", () => {
  assert.equal(landingSlotNote(3), "one of the 3 machine-wide sandbox slots is kept for landing");
  assert.equal(landingSlotNote(3, true), "one of the 3 machine-wide sandbox slots is kept for landing - beside another run, for any run's landing, outside every run's share");
});

test("the start line puts the capped note before the models and the colon, with the gate slots", () => {
  const line = startHeadLine({
    tickets: 10,
    dependants: 0,
    parked: 0,
    workers: 2,
    dryRun: false,
    models: "M",
    cap: { concurrency: 4, pool: { value: 3, source: "config", name: "maxSandboxes" }, beside: false, gateSlots: 2 },
  });
  assert.equal(
    line,
    "10 ticket(s), up to 2 at a time (CONCURRENCY=4, but maxSandboxes is 3 (machine settings) and one slot is kept for landing - `sandcastle size` suggests a figure; gate passes run beside them on 2 gate slots) - M:",
  );
});

test("an uncapped start line has no note, and the dependant, parked and dry-run parts keep their places", () => {
  assert.equal(startHeadLine({ tickets: 3, dependants: 0, parked: 0, workers: 3, dryRun: false, models: "M" }), "3 ticket(s), up to 3 at a time - M:");
  assert.equal(
    startHeadLine({ tickets: 5, dependants: 2, parked: 1, workers: 2, dryRun: true, models: "M", cap: { concurrency: 4, pool: { value: 3, source: "env", name: "SANDCASTLE_MAX_SANDBOXES" }, beside: true, gateSlots: 1 } }),
    "5 ticket(s) (2 start as their blockers land) (1 wait for a file git cannot merge), up to 2 at a time [DRY RUN] (CONCURRENCY=4, but SANDCASTLE_MAX_SANDBOXES is 3 and one slot is kept for landing - beside another run, for any run's landing, outside every run's share - `sandcastle size` suggests a figure; gate passes run beside them on 1 gate slot) - M:",
  );
});

test("burndown prints the start line through startHeadLine", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /console\.log\(\s*startHeadLine\(\{/);
});
