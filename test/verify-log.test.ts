// A red merged base said "RED TOGETHER - do not push" with no output kept anywhere: the gates on the
// merged base now leave their failures in .sandcastle/logs/verify-gates.log, as the base gates do
// in base-gates.log, and a green run removes a log an earlier red run left. Temp dirs only.
//
//   pnpm exec tsx --test test/verify-log.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-verify-log-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const { VERIFY_LOG, writeGateLog } = await import("../src/gates.ts");

test("a red verify writes each failure's full output under the header, in a logs dir it makes", () => {
  const log = join(TMP, "a", VERIFY_LOG);
  const failures = [{ name: "test", command: "pnpm test", exitCode: 1, output: "line 1\nFAIL: a and b cannot both exist" }];
  assert.equal(writeGateLog(log, "# gates on the merged main at abc1234: test=FAIL", failures), true);
  const text = readFileSync(log, "utf8");
  assert.match(text, /^# gates on the merged main at abc1234: test=FAIL\n\n===== test: pnpm test \(exit 1\)\nline 1\nFAIL: a and b cannot both exist\n/);
});

test("a green verify removes the log an earlier red run left", () => {
  const log = join(TMP, "b", VERIFY_LOG);
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
