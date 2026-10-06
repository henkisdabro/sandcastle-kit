// The file a node:test failure names (src/gates.ts failingTests and failingTestFile): the spec
// reporter's "✖ failing tests:" summary puts a "test at <path>:<line>:<col>" line above each failing
// test, and the base-red check can only decide for a test whose file it knows. Checked-in output, not a
// live `node --test`: a Node that defaults to TAP when piped would print no summary at all.
//
//   node --test test/failing-test-file.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, failingTestFile, failingTests } from "../src/gates.ts";

// Captured from `node --test src/a.test.js` on Node 24 (spec reporter, piped); `tsx --test src/a.test.js`
// prints the same lines. Stack frames trimmed.
const NODE_TEST = [
  "✔ passes (0.282335ms)",
  "✖ clock is early (0.300626ms)",
  "ℹ tests 2",
  "ℹ suites 0",
  "ℹ pass 1",
  "ℹ fail 1",
  "ℹ cancelled 0",
  "ℹ skipped 0",
  "ℹ todo 0",
  "ℹ duration_ms 30.405792",
  "",
  "✖ failing tests:",
  "",
  "test at src/a.test.js:4:1",
  "✖ clock is early (0.300626ms)",
  "  AssertionError [ERR_ASSERTION]: 1 == 2",
  "      at TestContext.<anonymous> (file:///tmp/project/src/a.test.js:4:39)",
  "      at Test.runInAsyncScope (node:async_hooks:227:14)",
  "    generatedMessage: true,",
  "    code: 'ERR_ASSERTION',",
  "  }",
].join("\n");

test("node --test and tsx --test: a failing test in src/a.test.js names that file", () => {
  assert.deepEqual(failingTests(NODE_TEST), ["src/a.test.js::clock is early"]);
  assert.equal(failingTestFile("src/a.test.js::clock is early"), "src/a.test.js");
});

test("a failing test inside describe gives the test, with its file, and no id for the suite", () => {
  const out = [
    "▶ suite",
    "  ✖ child (2.731849ms)",
    "✖ suite (2.841016ms)",
    "ℹ fail 1",
    "",
    "✖ failing tests:",
    "",
    "test at src/a.test.js:5:27",
    "✖ child (2.731849ms)",
    "  AssertionError [ERR_ASSERTION]: false == true",
  ].join("\n");
  assert.deepEqual(failingTests(out), ["src/a.test.js::child"]);
});

test("the same test name failing in two files gives two ids, each with its own file", () => {
  const out = [
    "✖ rolls over (1.1ms)",
    "✖ rolls over (1.3ms)",
    "✖ failing tests:",
    "",
    "test at test/a.test.ts:3:1",
    "✖ rolls over (1.1ms)",
    "  AssertionError: nope",
    "",
    "test at test/b.test.ts:9:1",
    "✖ rolls over (1.3ms)",
    "  AssertionError: nope",
  ].join("\n");
  const ids = failingTests(out);
  assert.deepEqual(ids, ["test/a.test.ts::rolls over", "test/b.test.ts::rolls over"]);
  assert.deepEqual(ids.map(failingTestFile), ["test/a.test.ts", "test/b.test.ts"]);
});

test("a test file that fails to load names that file", () => {
  const out = [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/project/test/nope.js' imported from /tmp/project/test/broken.test.js",
    "✖ test/broken.test.js (13.63845ms)",
    "ℹ fail 1",
    "",
    "✖ failing tests:",
    "",
    "test at test/broken.test.js:1:1",
    "✖ test/broken.test.js (13.63845ms)",
    "  'test failed'",
  ].join("\n");
  assert.deepEqual(failingTests(out), ["test/broken.test.js"]);
  assert.equal(failingTestFile("test/broken.test.js"), "test/broken.test.js");
});

test("a location outside the repo, or absolute, names no file", () => {
  const out = ["✖ failing tests:", "", "test at ../other/c.test.js:2:1", "✖ up (1ms)", "", "test at /abs/c.test.js:2:1", "✖ abs (1ms)"].join("\n");
  const ids = failingTests(out);
  assert.deepEqual(ids, ["../other/c.test.js::up", "/abs/c.test.js::abs"]);
  assert.deepEqual(ids.map(failingTestFile), [undefined, undefined]);
});

test("a failing test with no 'test at' line names no file", () => {
  const summary = ["✖ failing tests:", "", "✖ clock is early (0.3ms)", "  AssertionError: nope"].join("\n");
  assert.deepEqual(failingTests(summary), ["clock is early"]);
  assert.equal(failingTestFile("clock is early"), undefined);
  // No summary at all (TAP, a summary cut off, an older Node): the body's names, as before.
  const body = ["✖ clock is early (0.3ms)", "ℹ fail 1"].join("\n");
  assert.deepEqual(failingTests(body), ["clock is early"]);
  assert.equal(failingTestFile("clock is early"), undefined);
});

test("eslint's '✖ N problems' line in front of a node:test summary is still not a test", () => {
  const out = ["✖ 2 problems (2 errors, 0 warnings)", "✖ failing tests:", "", "test at src/a.test.js:4:1", "✖ clock is early (0.3ms)"].join("\n");
  assert.deepEqual(failingTests(out), ["src/a.test.js::clock is early"]);
});

test("a summary the gate's output clip cut through names no file: a test it lost could be the branch's own", () => {
  const entry = (file: string, name: string) => [`test at ${file}:3:1`, `✖ ${name} (1ms)`, ...Array(600).fill("    at a long stack frame of the failure")];
  const out = clip(
    ["✖ base red (1ms)", "✖ own red (1ms)", "✖ also base (1ms)", "", "✖ failing tests:", "", ...entry("test/a.test.js", "base red"), ...entry("test/b.test.js", "own red"), ...entry("test/c.test.js", "also base")].join("\n"),
  );
  assert.ok(!out.includes("own red (1ms)\n    at"), "the fixture's clip must cut the middle entry away");
  const ids = failingTests(out);
  assert.ok(ids.includes("own red"));
  assert.deepEqual(ids.map(failingTestFile), ids.map(() => undefined));
});
