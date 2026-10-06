// The base-gate cache record (src/gates.ts): a green result makes the same key
// hit, a later red result at that key clears it, and another key never hits.
//
//   node --test test/base-cache.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { baseCacheHit, noteBaseResult } from "../src/gates.ts";

const root = () => mkdtempSync(join(tmpdir(), "sandcastle-base-cache-"));

test("no record is a miss", () => {
  assert.equal(baseCacheHit(root(), "k1"), false);
});

test("a green result makes the same key hit, and a different key miss", () => {
  const r = root();
  noteBaseResult(r, "k1", true);
  assert.equal(baseCacheHit(r, "k1"), true);
  assert.equal(baseCacheHit(r, "k2"), false);
});

test("a red result at a cached key clears the record", () => {
  const r = root();
  noteBaseResult(r, "k1", true);
  noteBaseResult(r, "k1", false);
  assert.equal(baseCacheHit(r, "k1"), false);
  assert.equal(existsSync(join(r, ".sandcastle/.run/base-gates.json")), false);
});

test("a red result at a different key still clears the record", () => {
  const r = root();
  noteBaseResult(r, "k1", true);
  noteBaseResult(r, "k2", false);
  assert.equal(baseCacheHit(r, "k1"), false);
});

test("a red result with no record is harmless", () => {
  const r = root();
  noteBaseResult(r, "k1", false);
  assert.equal(baseCacheHit(r, "k1"), false);
});
