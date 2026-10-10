// A red base check leaves its failures in .sandcastle/logs/base-gates.log, and a green one removes a log an
// earlier red run left. (The verify streams its own log as its gates run: test/verify-log-layout.test.ts.)
// Temp dirs only.
//
//   pnpm test:file test/verify-log.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-verify-log-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const { writeGateLog } = await import("../src/gates.ts");

test("a red base check writes each failure's full output under the header, in a logs dir it makes", () => {
  const log = join(TMP, "a", "base-gates.log");
  const failures = [{ name: "test", command: "pnpm test", exitCode: 1, output: "line 1\nFAIL: a and b cannot both exist" }];
  assert.equal(writeGateLog(log, "# gates on main at abc1234: test=FAIL", failures), true);
  const text = readFileSync(log, "utf8");
  assert.match(text, /^# gates on main at abc1234: test=FAIL\n\n===== test: pnpm test \(exit 1\)\nline 1\nFAIL: a and b cannot both exist\n/);
});

test("a green base check removes the log an earlier red run left", () => {
  const log = join(TMP, "b", "base-gates.log");
  writeGateLog(log, "# red", [{ name: "test", command: "t", exitCode: 1, output: "x" }]);
  assert.ok(existsSync(log));
  assert.equal(writeGateLog(log, "# green", []), false);
  assert.ok(!existsSync(log));
});

test("extra output (red hook tests, a refused git hook) writes a log on its own", () => {
  const log = join(TMP, "c", "base-gates.log");
  assert.equal(writeGateLog(log, "# base", [], "===== git hook pre-commit\nrefused\n"), true);
  assert.match(readFileSync(log, "utf8"), /===== git hook pre-commit\nrefused/);
});
