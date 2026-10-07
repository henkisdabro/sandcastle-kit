// The run's heartbeat line (src/burndown.ts) names a ticket that has waited for a sandbox slot
// for longer than a typical issue takes.
//
//   node --test test/heartbeat-slot-wait.test.ts

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

test("a ticket that waited for a slot longer than a typical issue is named with how long", () => {
  const line = heartbeatLine({ now, clock: "14:05", working, slotWaits: [{ ref: "#9", since: now - 120 * MIN }], typicalMs: 40 * MIN });
  assert.equal(line, "[14:05] working: #12 implement 7m; waiting for a sandbox slot: #9 120m");
});

test("a ticket that has waited less than a typical issue is not named", () => {
  const line = heartbeatLine({ now, clock: "14:05", working, slotWaits: [{ ref: "#9", since: now - 39 * MIN }], typicalMs: 40 * MIN });
  assert.equal(line, "[14:05] working: #12 implement 7m");
});

test("with no history of issue lengths no waiting ticket is named", () => {
  assert.equal(heartbeatLine({ now, clock: "14:05", working, slotWaits: [{ ref: "#9", since: now - 600 * MIN }], typicalMs: typicalIssueMs({}) }), "[14:05] working: #12 implement 7m");
});

test("a long wait is named even when no ticket is working, and nothing waiting and nothing working says nothing", () => {
  assert.equal(heartbeatLine({ now, clock: "14:05", working: [], slotWaits: [{ ref: "#9", since: now - 90 * MIN }], typicalMs: typicalIssueMs({ issue: 2400 }) }), "[14:05] waiting for a sandbox slot: #9 90m");
  assert.equal(heartbeatLine({ now, clock: "14:05", working: [], slotWaits: [], typicalMs: 40 * MIN }), undefined);
});
