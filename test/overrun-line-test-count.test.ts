// The overrun line lists the source files a ticket's Touches line missed in full and folds test
// paths into a count: a refactor edits many tests, and listing them buries the real overruns.
//
//   node --test test/overrun-line-test-count.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { overrunLine } = await import("../src/report.ts");

const HEAD = "changed beyond its Touches line:";

test("test files fold into a count, other paths stay listed", () => {
  assert.equal(overrunLine(["test/a.test.ts", "src/b.ts", "test/c.test.ts", "docs/d.md"]), `${HEAD} src/b.ts, +2 test files, +1 docs file`);
});

test("one test file is singular", () => {
  assert.equal(overrunLine(["src/b.ts", "test/a.test.ts"]), `${HEAD} src/b.ts, +1 test file`);
});

test("test files alone are still reported, as a count", () => {
  assert.equal(overrunLine(["test/a.test.ts", "pkg/__tests__/b.ts"]), `${HEAD} +2 test files`);
});

test("no test files, no count", () => {
  assert.equal(overrunLine(["src/b.ts", "src/c.ts"]), `${HEAD} src/b.ts, src/c.ts`);
});
