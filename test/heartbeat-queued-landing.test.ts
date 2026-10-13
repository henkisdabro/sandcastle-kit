// A green ticket that waits for the landing worker is on the run's heartbeat line: between its gates
// going green and its landing it is in neither the working nor the landing list, and read as finished.
//
//   pnpm test:file test/heartbeat-queued-landing.test.ts

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
const base = { now, clock: "17:57", working: [] };

test("a green ticket queued to land is a heartbeat line, with how long it has waited", () => {
  const line = heartbeatLine({ ...base, queued: [{ ref: "#12", since: now - 4 * MIN }, { ref: "#13", since: now - 90_000 }] });
  assert.equal(line, "[17:57] queued to land: #12 4m, #13 2m");
});

test("the queued part follows the waiting-to-resolve part", () => {
  const line = heartbeatLine({
    ...base,
    landing: [{ ref: "#431", since: now - 3 * MIN }],
    resolving: [{ ref: "#429", since: now - 12 * MIN }],
    queued: [{ ref: "#12", since: now - 4 * MIN }],
  });
  assert.equal(line, "[17:57] landing: #431 3m; waiting to resolve a conflict: #429 12m; queued to land: #12 4m");
});

test("an empty queued list says nothing", () => {
  assert.equal(heartbeatLine({ ...base, queued: [] }), undefined);
});

// burndown() needs Docker, so no test drives it: the call sites are held by their text.
const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");

test("the heartbeat reads the tickets queued to land: set at the ready mark, cleared at the landing or the ending", () => {
  assert.match(source, /queued: \[\.\.\.queuedToLand\]/);
  assert.match(source, /queuedToLand\.set\(issue\.id, Date\.now\(\)\);\s+bookkeep\(issue\.id, \(\) => ledger\.ready\(/);
  assert.match(source, /queuedToLand\.delete\(o\.issue\);\s+landing\.set\(o\.issue/);
  assert.match(source, /case "ended":[^]*?queuedToLand\.delete\(c\.id\)/);
});
