// `pnpm test` runs the status view's scenarios a second time at 180 columns, in the wide header's first
// band (170 up to about 195), where the logo cell once kept 40% of the pane and cut the run, machine and
// model cells. The default 80 and a wide 200 never showed it. No Docker, no network.
//
//   pnpm test:file test/status-wide-band.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");

test("pnpm test runs the status view's scenarios at 80 and again at 180 columns", () => {
  const script: string = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).scripts.test;
  assert.match(script, /bash test\/status\.test\.sh && COLS=180 bash test\/status\.test\.sh && /);
});

test("the wide header's logo cell is sized by the logo, not by a share of the pane", () => {
  const src = readFileSync(join(KIT, "status.sh"), "utf8");
  assert.ok(!src.includes("split_cols 40 20 20 20"), "the logo cell keeps 40% of the pane again");
  assert.match(src, /room=\$\(\( WIDE_RUN - 12 \)\)/, "the paused run cell's room is not the run cell's real width");
});
