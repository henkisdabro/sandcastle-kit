// `redSubject` reads only the lines that say something failed, so a failing line it cannot read
// names nobody: a forced-colour runner's "FAIL" behind a colour code, and tsc's
// "file(line,col): error" (its plain format, with no "file:line:col") in a test file.
//
//   node --test test/red-subject-colour-and-tsc.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// landing.ts reaches pool.ts and sandbox.ts, which derive their directories from these at import.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { redSubject } = await import("../src/landing.ts");

const tree = ["src/a.ts", "src/a.test.ts", "src/b.ts", "src/b.test.ts", "pkg/b.py", "tests/test_a.py", "tests/test_b.py"];
const texts: Record<string, string> = {
  "src/a.test.ts": 'import { a } from "./a";\n',
  "src/b.test.ts": 'import { b } from "./b";\n',
  "tests/test_b.py": "from pkg.b import b\n",
};
const subject = (output: string) => [...redSubject(output, tree, (f) => texts[f])].sort();

test("a coloured FAIL line names its file, and a coloured pass line still adds nothing", () => {
  const output = ["\x1b[32m✓\x1b[39m src/a.test.ts (3 tests)", "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/b.test.ts"].join("\n");
  assert.deepEqual(subject(output), ["src/b.test.ts", "src/b.ts"]);
  assert.deepEqual(subject("\x1b[0m\x1b[7m\x1b[1m\x1b[32m PASS \x1b[39m\x1b[22m\x1b[27m\x1b[0m src/a.test.ts\n"), []);
  assert.deepEqual(subject("tests/test_a.py \x1b[32m....\x1b[0m\ntests/test_b.py \x1b[31mF\x1b[0m\n"), ["pkg/b.py", "tests/test_b.py"]);
});

test("tsc's plain error line names the test file it is in", () => {
  assert.deepEqual(subject("src/b.test.ts(5,17): error TS2554: Expected 2 arguments, but got 1.\n"), ["src/b.test.ts", "src/b.ts"]);
});
