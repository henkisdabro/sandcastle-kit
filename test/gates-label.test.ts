// The gates wait line names the project, as the landing one does:
// "<project> #N gates: waiting for a machine-wide gates slot (...)".
//
//   pnpm exec tsx --test test/gates-label.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots live under the cache dir; a test must not take real ones.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gatesLabel } = await import("../src/burndown.ts");

test("the gates label names the project before the ticket", () => {
  assert.equal(gatesLabel({ name: "demo-app" }, (id) => `#${id}`, "252"), "demo-app #252 gates");
});

test("the gates label follows the tracker's ref, as the landing label does", () => {
  assert.equal(gatesLabel({ name: "demo-app" }, (id) => `ENG-${id}`, "7"), "demo-app ENG-7 gates");
});

test("a landing's gates are named apart from the branch's own", () => {
  assert.equal(gatesLabel({ name: "demo-app" }, (id) => `#${id}`, "261", "landing gate"), "demo-app #261 landing gate");
});
