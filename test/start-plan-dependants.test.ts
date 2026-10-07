// A ticket that waits for a blocker in the same run was named twice in the start plan: once in the
// ticket list ("waits for a blocker in this run") and again under it ("#432 waits for #446 to close").
// Its own line now names the blocker, and the waits under the list leave it out. burndown() needs
// Docker, so its wiring is held by its source. No Docker, model or network.
//
//   node --test test/start-plan-dependants.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");

test("an in-run dependant's plan line names its blockers", () => {
  assert.match(src, /dependants\.includes\(i\) \? ` - waits for \$\{blockers\} in this run`/);
});

test("the waits under the ticket list leave out the in-run dependants", () => {
  assert.match(src, /sayWaits\(new Set\(dependants\.map\(\(d\) => d\.id\)\)\);/);
  assert.match(src, /if \(!inRun\.has\(w\.issue\)\) console\.log\(`  \$\{ref\(w\.issue\)\} waits for/);
});
