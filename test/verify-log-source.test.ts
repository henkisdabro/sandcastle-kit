// verifyBase hands the verify log to the gates (src/gates.ts), and a run that skipped its verify removes a stale
// one (src/burndown.ts, which no test drives: it needs Docker).
//
//   pnpm test:file test/verify-log-source.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const gates = readFileSync(new URL("../src/gates.ts", import.meta.url), "utf8");
const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");

test("the verify streams its gates into the verify log", () => {
  assert.match(gates, /gateBase\(project, image, planFile, "verify", false, runId, true, true, check, undefined, exclusive, log\)/);
  assert.match(gates, /\{ log \}, ownSlot\)/);
});

test("a skipped verify removes an earlier run's log, and the log is no longer written afterwards", () => {
  assert.match(burndown, /if \(verifySkipped\) rmSync\(join\(project\.root, VERIFY_LOG\)/);
  assert.doesNotMatch(burndown, /writeGateLog\(join\(project\.root, VERIFY_LOG\)/);
});
