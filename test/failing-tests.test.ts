// The failing tests a red gate names (src/gates.ts failingTests), one sample
// output per runner. Pure string parsing, so it behaves the same on macOS and
// Linux; CRLF output is covered because a Windows-flavoured runner can emit it.
//
//   pnpm test:file test/failing-tests.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { failingTests } from "../src/gates.ts";

test("pytest: FAILED and ERROR lines name path::test", () => {
  const out = [
    "=========================== short test summary info ===========================",
    "FAILED tests/test_a.py::test_one - assert 1 == 2",
    "ERROR tests/test_b.py::test_two - ImportError",
    "FAILED tests/test_a.py::test_one - assert 1 == 2",
  ].join("\n");
  assert.deepEqual(failingTests(out), ["tests/test_a.py::test_one", "tests/test_b.py::test_two"]);
});

test("vitest and jest: FAIL lines name the file", () => {
  const out = [" FAIL  src/a.test.ts > adds numbers", " ❯ src/a.test.ts:3:5", "FAIL src/b.test.js", "Tests: 2 failed"].join("\n");
  assert.deepEqual(failingTests(out), ["src/a.test.ts", "src/b.test.js"]);
});

test("node:test TAP: a nested subtest and its parent both count, a trailing directive does not", () => {
  const out = [
    "TAP version 13",
    "# Subtest: parses",
    "    # Subtest: inner case",
    "    not ok 1 - inner case",
    "      ---",
    "      duration_ms: 0.5",
    "      ...",
    "not ok 1 - parses",
    "ok 2 - fine",
    "not ok 3 - flaky # TODO",
  ].join("\n");
  assert.deepEqual(failingTests(out), ["inner case", "parses", "flaky"]);
});

test("node:test spec: durations are dropped, the 'failing tests:' header is not a test, and the summary names the file", () => {
  const out = [
    "▶ suite",
    "  ✔ passes (0.4ms)",
    "  ✖ breaks (1.2ms)",
    "▶ suite (3.1ms)",
    "ℹ fail 1",
    "✖ failing tests:",
    "",
    "test at test/a.test.ts:5:3",
    "✖ breaks (1.2ms)",
    "  AssertionError: nope",
  ].join("\n");
  assert.deepEqual(failingTests(out), ["test/a.test.ts::breaks"]);
});

test("eslint: its '✖ N problems' summary is not a test", () => {
  const out = [
    "/src/a.ts",
    "  3:7  error  'x' is assigned a value but never used  no-unused-vars",
    "",
    "✖ 1 problem (1 error, 0 warnings)",
    "",
    "✖ 12 problems (10 errors, 2 warnings)",
  ].join("\n");
  assert.deepEqual(failingTests(out), []);
});

test("go test: --- FAIL lines name the test, subtests included, and a bare FAIL line adds nothing", () => {
  const out = [
    "=== RUN   TestSum",
    "--- FAIL: TestSum (0.00s)",
    "    --- FAIL: TestSum/negative (0.00s)",
    "FAIL",
    "exit status 1",
    "FAIL\texample.com/m\t0.004s",
  ].join("\n");
  assert.deepEqual(failingTests(out), ["TestSum", "TestSum/negative", "example.com/m"]);
});

test("cargo test: only 'test path::name ... FAILED' lines count", () => {
  const out = [
    "running 3 tests",
    "test util::ok_case ... ok",
    "test util::bad_case ... FAILED",
    "test util::ignored_case ... ignored",
    "failures:",
    "    util::bad_case",
    "test result: FAILED. 1 passed; 1 failed",
  ].join("\n");
  assert.deepEqual(failingTests(out), ["util::bad_case"]);
});

test("CRLF output gives the same ids, and the list is capped at five", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`);
  assert.deepEqual(failingTests(lines.join("\r\n")), ["case 1", "case 2", "case 3", "case 4", "case 5"]);
});
