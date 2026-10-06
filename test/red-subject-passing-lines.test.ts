// `redSubject` names a test file only where the gate output says it failed: vitest's "✓ a.test.ts",
// jest's "PASS a.test.ts" and pytest's "test_a.py ...." list every passing file, and blaming those
// named each landed ticket that touched any tested module. One passing and one failing file per runner.
//
//   node --test test/red-subject-passing-lines.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// landing.ts reaches pool.ts and sandbox.ts, which derive their directories from these at import.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { redSubject } = await import("../src/landing.ts");

const tree = ["src/a.ts", "src/a.test.ts", "src/b.ts", "src/b.test.ts", "pkg/a.py", "pkg/b.py", "tests/test_a.py", "tests/test_b.py"];
const texts: Record<string, string> = {
  "src/a.test.ts": 'import { a } from "./a";\n',
  "src/b.test.ts": 'import { b } from "./b";\n',
  "tests/test_a.py": "from pkg.a import a\n",
  "tests/test_b.py": "from pkg.b import b\n",
};
const read = (f: string) => texts[f];
const subject = (output: string) => [...redSubject(output, tree, read)].sort();

test("vitest: a ✓ file adds nothing, a FAIL line and its stack frame add the failing file and what it imports", () => {
  const output = [
    " ✓ src/a.test.ts (3 tests) 4ms",
    " ❯ src/b.test.ts (2 tests | 1 failed) 6ms",
    "   × b > adds",
    "",
    " FAIL  src/b.test.ts > b > adds",
    "AssertionError: expected 1 to be 2",
    " ❯ src/b.test.ts:5:17",
  ].join("\n");
  assert.deepEqual(subject(output), ["src/b.test.ts", "src/b.ts"]);
  assert.deepEqual(subject(" ✓ src/a.test.ts (3 tests) 4ms\n ❯ src/b.test.ts (2 tests | 1 failed)\n"), ["src/b.test.ts", "src/b.ts"]);
  assert.deepEqual(subject(" ✓ src/a.test.ts (3 tests) 4ms\n"), []);
});

test("jest: a PASS file adds nothing, a FAIL file and its stack frame do", () => {
  const output = [
    "PASS src/a.test.ts",
    "FAIL src/b.test.ts",
    "  ● b › adds",
    "    expect(received).toBe(expected)",
    "      at Object.<anonymous> (src/b.test.ts:5:17)",
  ].join("\n");
  assert.deepEqual(subject(output), ["src/b.test.ts", "src/b.ts"]);
  assert.deepEqual(subject("PASS src/a.test.ts\n"), []);
});

test("pytest: a dotted file adds nothing, a file with an F, FAILED and a traceback frame do", () => {
  const output = [
    "tests/test_a.py ....                                [ 50%]",
    "tests/test_b.py F                                   [100%]",
    "",
    "tests/test_b.py:7: AssertionError",
    "FAILED tests/test_b.py::test_b - assert 1 == 2",
  ].join("\n");
  assert.deepEqual(subject(output), ["pkg/b.py", "tests/test_b.py"]);
  assert.deepEqual(subject("tests/test_a.py ....\ntests/test_b.py F.\n"), ["pkg/b.py", "tests/test_b.py"]);
  assert.deepEqual(subject("tests/test_a.py ....                                [100%]\n"), []);
  assert.deepEqual(subject('  File "tests/test_b.py", line 7, in test_b\n'), ["pkg/b.py", "tests/test_b.py"]);
});
