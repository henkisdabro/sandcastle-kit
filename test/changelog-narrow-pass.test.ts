// With `changelog: true` only a full review's set replaces the ticket's lines; a narrow pass (after a
// conflict resolution, a base merge or a repair) sees only what it reviewed, so its lines are added, and
// its prompt asks for lines about its own changes alone. No Docker, model or network.
//
//   pnpm exec tsx --test test/changelog-narrow-pass.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { addChangelog } = await import("../src/burndown.ts");
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");

const tag = (...lines: string[]) => lines.map((l) => `<changelog>${l}</changelog>`).join("\n");

test("a narrow pass's line is added to the implementer's, not a replacement of them", () => {
  const lines: string[] = [];
  addChangelog(lines, tag("Added: a key", "Fixed: a crash"));
  addChangelog(lines, tag("Upgrading: run setup again"), true);
  assert.deepEqual(lines, ["Added: a key", "Fixed: a crash", "Upgrading: run setup again"]);
});

test("a narrow pass that repeats a line already there does not show it twice", () => {
  const lines: string[] = [];
  addChangelog(lines, tag("Added: a key"));
  addChangelog(lines, tag("Added: a key", "Fixed: a crash"), true);
  assert.deepEqual(lines, ["Added: a key", "Fixed: a crash"]);
});

test("a narrow pass that gives none, or only a dropped tag, leaves the set standing and counts the drop", () => {
  const lines: string[] = [];
  addChangelog(lines, tag("Added: a key"));
  assert.equal(addChangelog(lines, "Nothing.", true), 0);
  assert.equal(addChangelog(lines, tag("Fixed: a commit 3f2a9c1d in it"), true), 1);
  assert.deepEqual(lines, ["Added: a key"]);
});

test("a full review's set still replaces the earlier one", () => {
  const lines: string[] = [];
  addChangelog(lines, tag("Added: a key"));
  addChangelog(lines, tag("Added: a new key", "Fixed: a crash"));
  assert.deepEqual(lines, ["Added: a new key", "Fixed: a crash"]);
});

test("only the full review's prompt asks for the whole set; the narrow ones ask for their own lines", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = {
    root, name: "t", baseBranch: "main", label: "ready-for-agent", concurrency: 1, mounts: [], setup: [],
    lean: { keep: [], dropHooks: [] }, gates: [{ name: "unit", command: "true" }], hookTests: [], land: "merge" as const,
    generated: [], implement: {}, review: {}, repair: {}, tracker: fakeTracker(), changelog: true,
  };
  const paths = renderPrompts(p, makeTracker(p));
  assert.match(readFileSync(paths.review, "utf8"), /full set of lines for the whole branch/);
  for (const kind of ["rereview", "remerge"] as const) {
    const text = readFileSync(paths[kind], "utf8");
    assert.doesNotMatch(text, /full set of lines/, kind);
    assert.match(text, /only for a user-facing change you made yourself/, kind);
    assert.match(text, /added to the implementer's/, kind);
  }
});
