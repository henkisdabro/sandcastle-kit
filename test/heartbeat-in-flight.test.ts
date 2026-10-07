// The run's heartbeat (src/burndown.ts) is not silent while only landings and resolve waits are in
// flight, and a gates step that waits for a gates slot says so and counts its time from the first gate.
//
//   node --test test/heartbeat-in-flight.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// src/ reads the config and cache directories when it loads.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { heartbeatLine } = await import("../src/burndown.ts");

const MIN = 60_000;
const now = 10 * 60 * MIN;
const base = { now, clock: "17:57", working: [], slotWaits: [] };

test("a landing in flight is a heartbeat line, with the step it says and how long it has been at it", () => {
  const line = heartbeatLine({ ...base, landing: [{ ref: "#431", phase: "gates: waiting for a gates slot", since: now - 4 * MIN }, { ref: "#437", since: now - 90_000 }] });
  assert.equal(line, "[17:57] landing: #431 gates: waiting for a gates slot 4m, #437 2m");
});

test("a sent-back ticket waiting to resolve is a heartbeat line", () => {
  assert.equal(heartbeatLine({ ...base, resolving: [{ ref: "#429", since: now - 12 * MIN }] }), "[17:57] waiting to resolve a conflict: #429 12m");
});

test("tickets working, landing and waiting to resolve are one line, in that order", () => {
  const line = heartbeatLine({
    ...base,
    working: [{ ref: "#12", phase: "gates: waiting for a gates slot", since: now - 4 * MIN }],
    landing: [{ ref: "#431", phase: "gates", since: now - 3 * MIN }],
    resolving: [{ ref: "#429", since: now - 12 * MIN }],
  });
  assert.equal(line, "[17:57] working: #12 gates: waiting for a gates slot 4m; landing: #431 gates 3m; waiting to resolve a conflict: #429 12m");
});

test("nothing in flight says nothing", () => {
  assert.equal(heartbeatLine({ ...base, landing: [], resolving: [] }), undefined);
});

// burndown() needs Docker, so no test drives it: the call sites are held by their text.
const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");

test("a gates step's time restarts at its first gate, and its slot wait is told as a wait", () => {
  assert.match(source, /step\.phase = "gates: waiting for a gates slot"/);
  assert.match(source, /step\.phase = "gates";\s+if \(i === 0\) step\.since = Date\.now\(\)/);
});

test("the heartbeat reads the landings in flight and the resolve waits the scheduler tells", () => {
  assert.match(source, /landing: \[\.\.\.landing\]/);
  assert.match(source, /resolving: \[\.\.\.resolving\]/);
  assert.match(source, /landing\.set\(o\.issue/);
  assert.match(source, /case "resolve waits":\s+[^\n]*\n\s+if \(!resolving\.has\(c\.id\)\) resolving\.set\(c\.id, Date\.now\(\)\)/);
  assert.match(source, /\.\.\.landings, tell,/);
});
