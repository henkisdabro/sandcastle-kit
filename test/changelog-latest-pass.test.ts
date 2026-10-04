// With `changelog: true` a reviewer that rewrites a change's line replaces the implementer's rather
// than adding a second: the review prompt asks for the branch's whole set, and the ticket keeps the
// latest pass's set. No Docker, model or network.
//
//   pnpm exec tsx --test test/changelog-latest-pass.test.ts

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

test("a reviewer's rewording of the implementer's line shows once, however few words they share", () => {
  const lines: string[] = [];
  addChangelog(lines, tag("Fixed: Every sandbox the kit creates now has a git identity, so a commit made in one no longer fails."));
  // Word overlap with the line above is about 0.45: the old threshold counted these as two changes.
  addChangelog(lines, tag("Fixed: sandboxes where no agent runs (the gate and landing ones) now have a git identity too."));
  assert.deepEqual(lines, ["Fixed: sandboxes where no agent runs (the gate and landing ones) now have a git identity too."]);
});

test("two different changes in one pass both show, however alike their words", () => {
  const lines: string[] = [];
  addChangelog(lines, tag("Added: `sandcastle size --json` prints the report as JSON", "Added: `sandcastle status --json` prints the report as JSON"));
  assert.equal(lines.length, 2, lines.join("\n"));
});

test("a later pass's distinct change that shares words is kept, with the restated set", () => {
  const lines: string[] = [];
  addChangelog(lines, tag("Fixed: the report drops a line"));
  addChangelog(lines, tag("Fixed: the report drops a line", "Fixed: the report drops a header"));
  assert.deepEqual(lines, ["Fixed: the report drops a line", "Fixed: the report drops a header"]);
});

test("a pass that gives no line, or only dropped tags, leaves the earlier set standing", () => {
  const lines: string[] = [];
  addChangelog(lines, tag("Added: a thing"));
  assert.equal(addChangelog(lines, "No change.\n<changelog>...</changelog>"), 0);
  assert.equal(addChangelog(lines, tag("Fixed: a commit 3f2a9c1d in it")), 1);
  assert.deepEqual(lines, ["Added: a thing"]);
});

test("the review prompt asks for the branch's whole set, replacing the implementer's", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = {
    root, name: "t", baseBranch: "main", label: "ready-for-agent", concurrency: 1, mounts: [], setup: [],
    lean: { keep: [], dropHooks: [] }, gates: [{ name: "unit", command: "true" }], hookTests: [], land: "merge" as const,
    generated: [], implement: {}, review: {}, repair: {}, tracker: fakeTracker(), changelog: true,
  };
  const paths = renderPrompts(p, makeTracker(p));
  const review = readFileSync(paths.review, "utf8");
  assert.match(review, /full set of lines for the whole branch/);
  assert.match(review, /replaces the implementer's/);
  assert.doesNotMatch(readFileSync(paths.implement, "utf8"), /full set of lines/);
});
