// The base-gate cache record (src/gates.ts): a green result makes the same key
// hit, a later red result at that key clears it, and another key never hits; the key carries the
// installed Sandcastle version.
//
//   pnpm test:file test/base-cache.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { baseCacheHit, baseKey, noteBaseResult } from "../src/gates.ts";
import { sandcastleVersion } from "../src/sandbox.ts";

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

// A base proved green on one Sandcastle is proved again on the next: a new version may mount, or make
// read-only, what a gate's setup writes, so the green record of the old one says nothing of the new.
test("the key carries the installed Sandcastle version", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-base-key-"));
  const plan = join(dir, "plan.json");
  writeFileSync(plan, "{}");
  const project = { root: dir, baseBranch: "main", gates: [], setup: [] } as unknown as Project;
  const commit = "0".repeat(40);
  assert.notEqual(baseKey(project, "img", plan, commit, "0.12.0"), baseKey(project, "img", plan, commit, "0.14.0"));
  assert.equal(baseKey(project, "img", plan, commit), baseKey(project, "img", plan, commit, sandcastleVersion()));
  assert.match(sandcastleVersion(), /^\d+\.\d+\.\d+/);
});
