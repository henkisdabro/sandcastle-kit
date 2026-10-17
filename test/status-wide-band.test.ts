// `pnpm test` runs the status view's scenarios (test/status.test.sh) a second time at 180 columns, where the
// lanes sit beside the logo; the default 80 shows the lanes under it, in a summary line. Both run beside
// node:test (test/suite.sh), so they cost a gate no time of its own. No Docker, no network.
// (The layout at every width is test/status-render.test.ts's.)
//
//   pnpm test:file test/status-wide-band.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");

test("pnpm test runs the status view's scenarios at 80 and again at 180 columns, beside node:test", () => {
  const script: string = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).scripts.test;
  assert.match(script, /&& bash test\/suite\.sh node .*--test .*test\/\*\.test\.ts'$/);
  const suite = readFileSync(join(KIT, "test", "suite.sh"), "utf8");
  assert.match(suite, /^bash test\/status\.test\.sh >.* &$/m);
  assert.match(suite, /^COLS=180 bash test\/status\.test\.sh >.* &$/m);
  // Both are waited for, and a red one fails the suite.
  assert.equal(suite.match(/^wait "\$\w+" \|\| rc=1$/gm)?.length, 2);
});
