// An empty XDG_CACHE_HOME is unset (the XDG rule): the machine pool's slots directory is then under
// the home directory's .cache, never a relative path under the current directory. And the archive
// cleanup's line gives the raw streams' limit its unit. No Docker, no model calls, no network.
//
//   pnpm exec tsx --test test/cache-dir-and-prune-line.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = "";
const { DIR } = await import("../src/pool.ts");
const { prunedLine } = await import("../src/run.ts");

test("an empty XDG_CACHE_HOME gives an absolute slots directory under the home cache", () => {
  assert.ok(isAbsolute(DIR), DIR);
  assert.equal(DIR, join(homedir(), ".cache", "sandcastle-kit", "slots"));
});

test("the archive cleanup line names the unit of both limits", () => {
  assert.equal(prunedLine(15), "Deleted 15 archived log(s) past their age limit (14 days; raw .jsonl streams 2 days).");
});
