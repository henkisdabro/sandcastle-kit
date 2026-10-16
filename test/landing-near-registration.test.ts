// A run's `landingNear` (src/pool.ts `setLandingNear`) is in its pool registration, where every live run reads it: written
// whole beside the demand, only when it changes, and a person's cap (`sandcastle cap`, written from another process) is
// kept through it. `burndown()` needs Docker, so the line that hands the scheduler's `landing near` change to the pool is
// held by its source text. No Docker, no model.
//
//   pnpm test:file test/landing-near-registration.test.ts

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, pool, registrations, RUN_ID } from "./pool-sim.ts";

afterEach(cleanup);

const file = () => join(registrations, `${RUN_ID}.run`);
const registration = () => JSON.parse(readFileSync(file(), "utf8")) as { landingNear?: boolean; cap?: number; demand: number };

test("the field is in the registration from the join, and a change rewrites it with the cap kept", () => {
  pool.joinPool("near", 4, 2);
  pool.setLandingNear(false);
  assert.equal(registration().landingNear, false);
  pool.setCap("near", 2);
  pool.setLandingNear(true);
  assert.deepEqual([registration().landingNear, registration().cap, registration().demand], [true, 2, 2]);
  // A cap set after it keeps the field, and a demand change keeps both.
  pool.setCap("near", 1);
  pool.setDemand(3);
  assert.deepEqual([registration().landingNear, registration().cap, registration().demand], [true, 1, 3]);
});

test("the registration is rewritten only when the field changes", () => {
  pool.joinPool("near", 4, 2);
  pool.setLandingNear(true);
  // Each write renames a new file in, so an unchanged inode is no write.
  const before = statSync(file()).ino;
  pool.setLandingNear(true);
  assert.equal(statSync(file()).ino, before);
  pool.setLandingNear(false);
  assert.notEqual(statSync(file()).ino, before);
});

test("burndown hands the scheduler's landing near change to the pool's registration", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "burndown.ts"), "utf8");
  assert.match(src, /case "landing near":\s*(\/\/[^\n]*\n\s*)*return setLandingNear\(c\.near\);/);
});
