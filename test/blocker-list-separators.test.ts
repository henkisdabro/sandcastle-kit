// parseRefs (src/blockers.ts): a blocker list with a serial comma, a repeated "by" or an "or"
// keeps every ref, and prose after a separator is not swallowed. Pure: no network, no gh.
//
//   pnpm test:file test/blocker-list-separators.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing blockers.ts pulls in sandbox.ts, which derives USER_CONFIG from this.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { parseRefs } = await import("../src/blockers.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const base = { tracker: fakeTracker() } as unknown as Project;
const linear = { ...base, blockers: { linear: ["ENG"] } } as unknown as Project;
const gh = (...ids: string[]) => ids.map((id) => ({ kind: "github", id }));

test("a serial comma before 'and' keeps the last issue", () => {
  assert.deepEqual(parseRefs(base, "Blocked by #1, #2, and #3"), gh("1", "2", "3"));
});

test("a serial comma keeps a Linear ref and the issue after it", () => {
  assert.deepEqual(parseRefs(linear, "Blocked by #4, ENG-5, and #6"), [
    { kind: "github", id: "4" },
    { kind: "linear", id: "ENG-5" },
    { kind: "github", id: "6" },
  ]);
});

test("a repeated 'by' after 'and' keeps the second issue", () => {
  assert.deepEqual(parseRefs(base, "Blocked by #1 and by #2"), gh("1", "2"));
});

test("'or' and ', &' join refs too, so a guessed list holds the ticket back", () => {
  assert.deepEqual(parseRefs(base, "Blocked by #1 or #2"), gh("1", "2"));
  assert.deepEqual(parseRefs(base, "Blocked by #1, #2, & #3"), gh("1", "2", "3"));
  assert.deepEqual(parseRefs(base, "Blocked by #1, or by #2"), gh("1", "2"));
});

test("prose after a separator is not swallowed", () => {
  assert.deepEqual(parseRefs(base, "Blocked by #1, and then fix the docs"), gh("1"));
  assert.deepEqual(parseRefs(base, "Blocked by #1 and bypass #2"), gh("1"));
});
