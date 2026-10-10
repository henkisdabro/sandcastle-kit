// A red end-of-run verify is run again once, the second result kept, and a verify that is red again only through
// test timeouts (or a gate far slower than recorded) is called "likely load" in the closing summary instead of
// pointing at the sandbox's git identity. `burndown()` needs Docker, so its call sites are held by source matches;
// the re-run and the judgement are driven through their exports with made-up gate results.
//
//   pnpm test:file test/verify-rerun-load.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { likelyLoad, rerunRedVerify } = await import("../src/gates.ts");
const { render } = await import("../src/report.ts");
type Facts = Parameters<typeof render>[0];
type Run = Parameters<typeof rerunRedVerify>[0] extends () => Promise<infer R> ? R : never;

const red = (output: string, name = "test") => ({ name, command: "pnpm test", exitCode: 1, output });
const timeout30 = (n: number) =>
  Array.from({ length: n }, (_, i) => `FAIL  test/slow-${i}.test.ts > case ${i}\nError: Test timed out in 30000ms.`).join("\n");

test("a red verify is run again once and the second result is kept", async () => {
  const results: Run[] = [
    { gates: [{ name: "test", pass: false }], failures: [red("FAIL  a.test.ts")] },
    { gates: [{ name: "test", pass: true }], failures: [] },
  ];
  const said: string[] = [];
  let calls = 0;
  const kept = await rerunRedVerify(async () => results[calls++], (l) => said.push(l));
  assert.equal(calls, 2);
  assert.equal(kept, results[1]);
  assert.match(said.join("\n"), /re-running it once/);
  assert.match(said.join("\n"), /then green on a re-run - a flake/);
});

test("a verify that is red twice stops at two runs and keeps the second", async () => {
  let calls = 0;
  const kept = await rerunRedVerify(async () => ({ n: ++calls, gates: [{ name: "test", pass: false }], failures: [red("x")] }), () => {});
  assert.equal(calls, 2);
  assert.equal(kept.n, 2);
});

test("a green verify is not run again", async () => {
  let calls = 0;
  await rerunRedVerify(async () => (calls++, { gates: [{ name: "test", pass: true }], failures: [] }), () => {});
  assert.equal(calls, 1);
});

test("failures that are all test timeouts read as load, in vitest's, jest's and node:test's words", () => {
  const gates = [{ name: "test", pass: false }];
  assert.equal(likelyLoad([red(timeout30(3))], gates), true);
  assert.equal(likelyLoad([red("FAIL  a.test.ts > b\nExceeded timeout of 5000 ms for a test.")], gates), true);
  assert.equal(likelyLoad([red("✖ slow case (30002.1ms)\n  'test timed out after 30000ms'\n✖ failing tests:\n\ntest at test/a.test.ts:3:1\n✖ slow case (30002.1ms)\n  'test timed out after 30000ms'")], gates), true);
});

test("a failure that is not a timeout keeps it from reading as load, even beside timeouts", () => {
  const gates = [{ name: "test", pass: false }];
  assert.equal(likelyLoad([red("FAIL  a.test.ts > b\nAssertionError: expected 1 to be 2")], gates), false);
  assert.equal(likelyLoad([red(`${timeout30(1)}\nFAIL  other.test.ts > real bug\nAssertionError: nope`)], gates), false);
  assert.equal(likelyLoad([red(timeout30(1)), red("src/a.ts(1,1): error TS2322", "typecheck")], gates), false);
  assert.equal(likelyLoad([], [{ name: "test", pass: true }]), false);
});

// Each runner prints a failure's error twice (node:test in its "failing tests:" summary, vitest under the test and in
// "Failed Tests"), so one timeout beside one assertion has as many timeout lines as failing tests.
const nodeSpec = (second: string) =>
  `▶ suite\n  ✖ slow (30002ms)\n    'test timed out after 30000ms'\n  ✖ other (1.2ms)\n    ${second}\n✖ suite (30004ms)\n✖ failing tests:\n\ntest at test/a.test.ts:3:3\n✖ slow (30002ms)\n  'test timed out after 30000ms'\n\ntest at test/a.test.ts:9:3\n✖ other (1.2ms)\n  ${second}\n`;
const vitest = (second: string) =>
  ` ❯ test/a.test.ts (2 tests | 2 failed) 30010ms\n   × slow 30005ms\n     → Test timed out in 30000ms.\n   × other 3ms\n     → ${second}\n\n⎯⎯ Failed Tests 2 ⎯⎯\n\n FAIL  test/a.test.ts > slow\nError: Test timed out in 30000ms.\n⎯⎯[1/2]⎯\n\n FAIL  test/a.test.ts > other\n${second}\n⎯⎯[2/2]⎯\n`;
const jest = (second: string) =>
  `FAIL test/a.test.ts (35.1 s)\n  a\n    ✕ slow (5003 ms)\n    ✕ other (2 ms)\n\n  ● a › slow\n\n    thrown: "Exceeded timeout of 5000 ms for a test.\n\n  ● a › other\n\n    ${second}\n`;

test("one timeout beside a real failure is not load, though each runner prints the timeout twice", () => {
  const gates = [{ name: "test", pass: false }];
  for (const output of [nodeSpec, vitest, jest]) {
    assert.equal(likelyLoad([red(output("AssertionError: expected 1 to be 2"))], gates), false);
  }
  assert.equal(likelyLoad([red(nodeSpec("'test timed out after 30000ms'"))], gates), true);
  assert.equal(likelyLoad([red(vitest("Error: Test timed out in 30000ms."))], gates), true);
  assert.equal(likelyLoad([red(jest('thrown: "Exceeded timeout of 5000 ms for a test.'))], gates), true);
});

test("a red gate that ran three times its recorded time reads as load; twice does not", () => {
  const failures = [red("FAIL  a.test.ts > b\nAssertionError: expected 1 to be 2")];
  assert.equal(likelyLoad(failures, [{ name: "test", pass: false, ms: 81_000 }], { test: 18_000 }), true);
  assert.equal(likelyLoad(failures, [{ name: "test", pass: false, ms: 54_000 }], { test: 18_000 }), true);
  assert.equal(likelyLoad(failures, [{ name: "test", pass: false, ms: 36_000 }], { test: 18_000 }), false);
  // No record of the gate, or of the run: nothing to compare with.
  assert.equal(likelyLoad(failures, [{ name: "test", pass: false, ms: 81_000 }], { lint: 1_000 }), false);
  assert.equal(likelyLoad(failures, [{ name: "test", pass: false, ms: 81_000 }]), false);
  // A slow gate that passed is not the red.
  assert.equal(likelyLoad(failures, [{ name: "lint", pass: true, ms: 90_000 }, { name: "test", pass: false, ms: 1_000 }], { lint: 1_000, test: 1_000 }), false);
});

const facts = (verify: Facts["verify"]): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:00:00.000Z",
  finished: "2026-10-05T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: { "1": { state: "merged", title: "a" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "report",
  exitCode: 0,
  verify,
});
const lines = (verify: Facts["verify"]) => render(facts(verify), true).split("\n");

test("a red verify flagged as load says so and does not point at git identity", () => {
  for (const tree of [{ gatedTree: "#451" }, { cleanTree: "#451" }, {}]) {
    const out = lines({ green: false, line: "test=FAIL", likelyLoad: true, ...tree }).join("\n");
    assert.match(out, /Merged main re-gated: RED twice, likely load/);
    assert.match(out, /run `sandcastle gates` again/);
    assert.doesNotMatch(out, /git identity|the difference is the sandbox|RED TOGETHER|flaky or order-dependent/);
  }
});

test("a red verify with no load flag keeps the sandbox wording", () => {
  const out = lines({ green: false, line: "test=FAIL", gatedTree: "#451" }).join("\n");
  assert.match(out, /the difference is the sandbox, not the merge/);
  assert.match(out, /git identity/);
});

test("burndown() re-runs the verify and records the load flag from the landing's and the base gates' times", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /timed\("", "verify", \(\) => rerunRedVerify\(\(\) => verifyBase\(gateProject, image, planFile, runId, \(when\) => host\.check\(when\), host\.exclusive\)/);
  assert.match(source, /likelyLoad\(gated\.failures, gated\.gates, \{ \.\.\.baseGateMs, \.\.\.\(same && landed\.get\(same\)\?\.clean \? landingGateMs\.get\(same\) : undefined\) \}\)/);
  assert.match(source, /baseGateMs = gateMs\(await timed\("", "base gates"/);
  assert.match(source, /\.\.\.\(verifyLoad \? \{ likelyLoad: true \} : \{\}\)/);
});
