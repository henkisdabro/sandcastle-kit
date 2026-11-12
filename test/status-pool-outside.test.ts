// The status view's MACHINE lane counts a sandbox moved off the count while it waits for a gates slot
// (`sandboxes-waiting-<run>-<n>.lock`, src/pool.ts `uncountSlot`) apart from the counted slots, as the run's
// start line does: `3/3 +1 for gates`, never `4/3`, which reads as a broken limit.
//
//   pnpm test:file test/status-pool-outside.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildFixture } from "./status-fixture.ts";
import { drawFrame, machineSlots, readFacts } from "./status-run.ts";

const dir = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const fixture = buildFixture("live", dir);
after(() => fixture.stop());

const slots = join(fixture.cache, "sandcastle-kit", "slots");
const env = { XDG_CACHE_HOME: fixture.cache, SANDCASTLE_MAX_SANDBOXES: "3" };
const owner = readFileSync(join(slots, "sandboxes-1.lock"), "utf8").split(" ")[0]!;
const lock = (name: string) => {
  mkdirSync(slots, { recursive: true });
  writeFileSync(join(slots, name), `${owner} token run=aaaa label\n`);
};
// The fixture holds two counted sandbox slots; a third makes the limit of 3 full.
lock("sandboxes-3.lock");

const laneOf = (): Record<string, string> => {
  const drawn = drawFrame(fixture, { cols: 200, env });
  assert.equal(drawn.status, 0, drawn.stderr);
  return readFacts(drawn.raw, fixture.root).run;
};
const without = laneOf();

test("a full pool with no sandbox outside the limit draws 3/3, as before", () => {
  assert.equal(without.sandboxes?.split(" ")[0], "3/3");
  assert.equal(machineSlots(fixture, env).sandboxes, "3/3");
});

test("a sandbox waiting for a gates slot is drawn +1 for gates, and the gauge stays at the limit", () => {
  lock("sandboxes-waiting-aaaa-1.lock");
  assert.equal(machineSlots(fixture, env).sandboxes, "3/3 +1 for gates");
});

test("the rest of the MACHINE lane is the same with the uncounted lock as without it", () => {
  const { sandboxes: a, ...restWith } = laneOf();
  const { sandboxes: b, ...restWithout } = without;
  assert.equal(b, "3/3");
  assert.equal(a, "3/3 +1 for gates");
  assert.deepEqual(restWith, restWithout);
  assert.ok(restWith.gates && restWith["this run"], JSON.stringify(restWith));
});
