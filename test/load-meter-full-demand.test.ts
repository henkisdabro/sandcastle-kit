// `load.concurrency` counts only the time tickets work at full demand: the base gates (one slot) and the tail where
// the last tickets finish are bound by demand, so their duration is left out of the mean rather than carried as a low sample.
// Made-up clock; no Docker, model or network.
//
//   pnpm test:file test/load-meter-full-demand.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLoadMeter } = await import("../src/run.ts");

const HOUR = 3_600_000;

/** A meter on a clock the test moves, in hours. */
const meter = (slots: number) => {
  let hours = 0;
  const load = createLoadMeter(slots, () => hours * HOUR);
  return { load, at: (h: number) => (hours = h) };
};

test("a base-gate stretch at one slot does not pull the recorded load down", () => {
  const { load, at } = meter(3);
  load.sample(1, false); // the base gates: demand 1
  at(2);
  load.sample(3); // tickets start at full demand
  at(4);
  assert.equal(load.mean(), 3);
});

test("a demand-bound tail does not pull the recorded load down", () => {
  const { load, at } = meter(3);
  load.sample(3);
  at(2);
  load.sample(1, false); // the last tickets finish
  at(8);
  assert.equal(load.mean(), 3);
});

test("counted time still averages when the share moves while tickets work", () => {
  const { load, at } = meter(3);
  load.sample(1, false);
  at(1);
  load.sample(3);
  at(3);
  load.sample(1); // another run began: the share fell, tickets still at full demand
  at(5);
  load.sample(1, false);
  at(9);
  // (3 x 2h + 1 x 2h) / 4h = 2
  assert.equal(load.mean(), 2);
});

test("a run with no time at full demand records the start's slots", () => {
  const { load, at } = meter(2);
  load.sample(1, false);
  at(5);
  assert.equal(load.mean(), 2);
});

test("burndown() counts a look only while the run's demand covers its startable tickets", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /mine\.demand >= Math\.min\(CONCURRENCY, issues\.length\)\)/);
});
