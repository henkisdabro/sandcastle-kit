// A red end-of-run verify named its failing tests only in verify-gates.log: the run printed the last
// lines of the output (an assertion dump, the pnpm command) and the summary said only `test=FAIL`.
// `verifyFailing` reads the failing tests out of the verify's output, the run record carries them, and
// the summary's re-gated line names them. Temp dirs only; `burndown()` needs Docker, so its call sites
// are held by a source match.
//
//   pnpm test:file test/verify-failing-tests.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { verifyFailing, FAILING_TESTS_SHOWN } = await import("../src/gates.ts");
const { render } = await import("../src/report.ts");
type Facts = Parameters<typeof render>[0];

// node:test's spec reporter: the failures' assertion dumps, then the summary list, then pnpm's exit lines.
const SPEC_OUTPUT = (names: string[]) =>
  [
    ...names.flatMap((n) => [`✖ ${n} (3.1ms)`, "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "  1 !== 2"]),
    "ℹ tests 40",
    "ℹ pass " + (40 - names.length),
    "ℹ fail " + names.length,
    "✖ failing tests:",
    "",
    ...names.flatMap((n) => [`test at test/a.test.ts:10:1`, `✖ ${n} (3.1ms)`, "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "  1 !== 2"]),
    " ELIFECYCLE  Test failed. See above for more details.",
  ].join("\n");

const failure = (output: string) => ({ name: "test", command: "pnpm test", exitCode: 1, output });

test("a red verify with node test-runner output names its failing tests", () => {
  const got = verifyFailing([failure(SPEC_OUTPUT(["parses a ticket", "lands a branch"]))]);
  assert.deepEqual(got, { tests: ["test/a.test.ts::parses a ticket", "test/a.test.ts::lands a branch"], more: false });
});

test("a verify that names more tests than the excerpt shows says so", () => {
  const names = Array.from({ length: FAILING_TESTS_SHOWN + 2 }, (_, i) => `case ${i}`);
  const got = verifyFailing([failure(SPEC_OUTPUT(names))]);
  assert.deepEqual(got.tests, names.slice(0, FAILING_TESTS_SHOWN).map((n) => `test/a.test.ts::${n}`));
  assert.equal(got.more, true);
});

test("a verify whose output names no test names none, and a test on two red gates is named once", () => {
  assert.deepEqual(verifyFailing([failure("error: something broke\nELIFECYCLE")]), { tests: [], more: false });
  const two = [failure(SPEC_OUTPUT(["same"])), { ...failure(SPEC_OUTPUT(["same", "other"])), name: "lint" }];
  assert.deepEqual(verifyFailing(two).tests, ["test/a.test.ts::same", "test/a.test.ts::other"]);
});

const facts = (verify: Facts["verify"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: { "1": { state: "merged", title: "a" }, "2": { state: "merged", title: "b" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  verify,
});
const regated = (verify: Facts["verify"]) => render(facts(verify), true).split("\n").find((l) => l.startsWith("Merged main"));

test("the summary's re-gated line names the failing tests of a red verify", () => {
  assert.equal(
    regated({ green: false, line: "test=FAIL", failing: ["parses a ticket", "lands a branch"] }),
    "Merged main re-gated: RED TOGETHER (test=FAIL) - failing: parses a ticket, lands a branch - do not push main until it is fixed. Output: .sandcastle/logs/verify-gates.log",
  );
  assert.match(regated({ green: false, line: "test=FAIL", failing: ["a"], failingMore: true })!, /\(test=FAIL\) - failing: a, and more - do not push/);
});

test("a record with no failing tests, or ones of the wrong type, keeps the old line", () => {
  const old = "Merged main re-gated: RED TOGETHER (test=FAIL) - do not push main until it is fixed. Output: .sandcastle/logs/verify-gates.log";
  assert.equal(regated({ green: false, line: "test=FAIL" }), old);
  assert.equal(regated({ green: false, line: "test=FAIL", failing: [] }), old);
  assert.equal(regated({ green: false, line: "test=FAIL", failing: "x" } as unknown as Facts["verify"]), old);
});

test("the run prints the failing tests in the verify's red excerpt and records them", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /const verifyRed = verifyFailing\(gated\.failures\);/);
  assert.match(src, /--- verify failing tests: \$\{verifyRed\.tests\.join/);
  assert.match(src, /failing: verifyFailingTests\.tests/);
});
