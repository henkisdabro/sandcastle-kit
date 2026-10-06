// parseRefs (src/blockers.ts): which blockers a ticket body names after a
// "Blocked by" or "Depends on" phrase, and which it leaves alone. Pure: no
// network, no gh.
//
//   node --test test/blockers.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing blockers.ts pulls in sandbox.ts, which derives USER_CONFIG from this:
// nothing here may read the user's real config.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { parseRefs } = await import("../src/blockers.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const base = { tracker: fakeTracker() } as unknown as Project;
const withProject = (extra: object) => ({ ...base, ...extra }) as unknown as Project;

test("a list of issue numbers counts each, in order", () => {
  assert.deepEqual(parseRefs(base, "Blocked by #12, #13 and #14"), [
    { kind: "github", id: "12" },
    { kind: "github", id: "13" },
    { kind: "github", id: "14" },
  ]);
});

test("the phrase is case-insensitive and takes a colon", () => {
  assert.deepEqual(parseRefs(base, "depends on: #5"), [{ kind: "github", id: "5" }]);
});

test("a blocker named twice is returned once", () => {
  assert.deepEqual(parseRefs(base, "Blocked by #7. Also blocked by #7"), [{ kind: "github", id: "7" }]);
});

test("a reference without a trigger phrase is not a blocker", () => {
  assert.deepEqual(parseRefs(base, "see #9 for context"), []);
});

test("a Linear key counts only when the project configures it", () => {
  const linear = withProject({ blockers: { linear: ["ENG"] } });
  assert.deepEqual(parseRefs(linear, "Blocked by eng-42"), [{ kind: "linear", id: "ENG-42" }]);
  assert.deepEqual(parseRefs(base, "Blocked by eng-42"), []);
});

test("a ticket file path counts on a files tracker", () => {
  const files = withProject({ tracker: fakeTracker({ kind: "files" }) });
  assert.deepEqual(parseRefs(files, "Blocked by .scratch/cart/01-add-cart.md"), [{ kind: "file", id: ".scratch/cart/01-add-cart.md" }]);
});
