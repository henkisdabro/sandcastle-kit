// A test file's header names the way to run it alone, and agents copy it into the files they add: a
// header saying bare `node --test` taught them to skip the hermetic preloads and the temp directory
// that `pnpm test:file` sets up, which .sandcastle/rules.md asks for. No Docker, model calls or network.
//
//   pnpm test:file test/test-headers.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dir = join(import.meta.dirname);
const bareRun = /^\/\/\s+(?:[A-Z_]+=\S+\s+)*node --test test\//;

test("no test file's header runs a single file with bare node --test", () => {
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => bareRun.test(l)).map((l) => `${f}: ${l.trim()}`));
  assert.deepEqual(offenders, [], "write `//   pnpm test:file test/<x>.test.ts` instead");
});

test("the check matches the old header form and leaves other mentions alone", () => {
  assert.ok(bareRun.test("//   node --test test/a.test.ts"));
  assert.ok(bareRun.test("//   SCHEDULE_SEED=42 node --test test/a.test.ts"));
  assert.ok(!bareRun.test("//   pnpm test:file test/a.test.ts"));
  assert.ok(!bareRun.test('  scripts: { test: "node --test" },'));
});
