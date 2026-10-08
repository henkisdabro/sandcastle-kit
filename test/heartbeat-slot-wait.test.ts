// The run's heartbeat line (src/burndown.ts) says when the run has waited for a sandbox slot for longer
// than a typical issue takes. The wait is the run's: a worker leases its slot before it takes a ticket
// (slot first, src/schedule.ts), so no ticket is named.
//
//   pnpm test:file test/heartbeat-slot-wait.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// src/ reads the config and cache directories when it loads.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { heartbeatLine, typicalIssueMs } = await import("../src/burndown.ts");

const MIN = 60_000;
const now = 10 * 60 * MIN;
const working = [{ ref: "#12", phase: "implement", since: now - 7 * MIN }];

test("a run that waited for a slot longer than a typical issue says how long", () => {
  const line = heartbeatLine({ now, clock: "14:05", working, slotWait: now - 120 * MIN, typicalMs: 40 * MIN });
  assert.equal(line, "[14:05] working: #12 implement 7m; waiting for a sandbox slot: 120m");
});

test("a wait shorter than a typical issue is not said", () => {
  const line = heartbeatLine({ now, clock: "14:05", working, slotWait: now - 39 * MIN, typicalMs: 40 * MIN });
  assert.equal(line, "[14:05] working: #12 implement 7m");
});

test("with no history of issue lengths no wait is said", () => {
  assert.equal(heartbeatLine({ now, clock: "14:05", working, slotWait: now - 600 * MIN, typicalMs: typicalIssueMs({}) }), "[14:05] working: #12 implement 7m");
});

test("a long wait is said even when no ticket is working, and nothing waiting and nothing working says nothing", () => {
  assert.equal(heartbeatLine({ now, clock: "14:05", working: [], slotWait: now - 90 * MIN, typicalMs: typicalIssueMs({ issue: 2400 }) }), "[14:05] waiting for a sandbox slot: 90m");
  assert.equal(heartbeatLine({ now, clock: "14:05", working: [], typicalMs: 40 * MIN }), undefined);
});
