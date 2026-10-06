// A red line names the failing tests: a path stays as it is, while a test title (node:test reports
// titles, which are prose) is quoted and cut, so it does not run into the sentence around it.
//
//   node --test test/failing-test-wording.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { againLine, redDetail, redNote, requeuedLine } = await import("../src/landing.ts");

const TITLE = "the start line says whose plan is read: the login's account, or the token's";

test("a failing test title is quoted and cut in the requeue line, where a path is left as it is", () => {
  assert.equal(
    requeuedLine("red", ["317"], { gates: ["test"], failing: [TITLE] }),
    'requeued after red with #317 (gate test; failing "the start line says whose plan is read:…")',
  );
  assert.equal(requeuedLine("red", [], { gates: ["test"], failing: ["src/pair.test.ts", "test/a.py::test_b"] }), "requeued after red on the merged tree (gate test; failing src/pair.test.ts, test/a.py::test_b)");
});

test("a short title is quoted whole, and a title and a path mix in one line", () => {
  assert.equal(redDetail({ gates: ["test"], failing: ["lands a branch", "src/a.test.ts"] }), ' (gate test; failing "lands a branch", src/a.test.ts)');
  assert.equal(redNote({ with: [], gates: ["test"], failing: ["lands a branch"] }), 'red on the merged tree (gate test; failing "lands a branch")');
  assert.equal(againLine("red", [], { failing: [TITLE] }), 'red again on the merged tree after a requeue (failing "the start line says whose plan is read:…")');
});

test("a title of exactly the limit is quoted without a cut", () => {
  const exact = "x ".repeat(19) + "xx";
  assert.equal(exact.length, 40);
  assert.equal(redDetail({ failing: [exact] }), ` (failing "${exact}")`);
});
