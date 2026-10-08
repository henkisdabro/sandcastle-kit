// tsc must see every test file: a hand-picked include let type errors pile up in the ones left out.
// `mod/` stays out because its `claude-code` imports resolve only inside Claude Code.
//
//   pnpm test:file test/tsconfig-include.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const tsconfig = JSON.parse(readFileSync(join(import.meta.dirname, "..", "tsconfig.json"), "utf8"));

test("tsconfig includes all of src and test, and not mod", () => {
  assert.deepEqual(tsconfig.include, ["src", "test"]);
});
