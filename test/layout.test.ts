// The Herdr view's proportions (src/herdr.ts): the status view gets about half the screen, and
// the sandbox column ends in equal rows. Pure arithmetic on the split ratios - no Herdr.
//
//   pnpm test:file test/layout.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutRatios, stackRatio } from "../src/herdr.ts";

// Herdr's `--ratio` is the share the pane being split keeps; the new pane gets the rest.
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} is not about ${expected}`);

test("wide adopted tab: run 25%, status 50%, sandbox column 25%", () => {
  const r = layoutRatios(true, true);
  const run = r.status!;
  const status = (1 - run) * r.column;
  near(run, 0.25);
  near(status, 0.5);
  near(1 - run - status, 0.25);
});

test("narrow adopted tab: the status view below the run pane gets about half the area", () => {
  const r = layoutRatios(true, false);
  near((1 - r.status!) * r.column, 0.5);
});

test("own tab: status two thirds, sandboxes one third", () => {
  const r = layoutRatios(false, true);
  assert.equal(r.status, undefined);
  near(r.column, 0.67);
  assert.deepEqual(layoutRatios(false, false), r);
});

test("the sandbox column ends in equal rows for every pane count", () => {
  for (let panes = 1; panes <= 8; panes++) {
    // The first pane fills the column; each later one splits the last open pane.
    const rows = [1];
    for (let open = 1; open < panes; open++) {
      const last = rows.pop()!;
      const keep = stackRatio(open, panes);
      rows.push(last * keep, last * (1 - keep));
    }
    assert.equal(rows.length, panes);
    for (const row of rows) near(row, 1 / panes);
  }
});
