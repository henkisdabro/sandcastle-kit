// `pnpm test` runs the status view's scenarios (test/status.test.sh) a second time at 180 columns, where the
// lanes sit beside the logo; the default 80 shows the lanes under it, in a summary line. No Docker, no network.
// (The layout at every width is test/status-render.test.ts's.)
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
