// A red end-of-run verify judged likely load no longer stops a drain: `noRerunCause` lets a turn follow, `mustGateBase` says
// the turn that follows gates the base first, and the verify's slowness check falls back to each gate's typical time
// (`typicalGateMs`) when this turn's base gates did not run. Pure functions and the call sites' source, as the autonomy
// loop in src/cli.ts and `burndown()` need Docker and have no test harness. No Docker, model call or network.
//
//   pnpm test:file test/verify-load-drain.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { mustGateBase, noRerunCause } = await import("../src/autonomy.ts");
const { typicalGateMs } = await import("../src/run.ts");
const { likelyLoad } = await import("../src/gates.ts");
type Facts = Parameters<typeof noRerunCause>[0];

const facts = (verify: Facts["verify"]): Facts => ({ dryRun: false, tickets: {}, verify }) as unknown as Facts;
const RED = { green: false, line: "lint=pass test=FAIL" };

test("a red verify judged likely load does not stop the drain, one that is not does, and one that could not run still does", () => {
  assert.equal(noRerunCause(facts({ ...RED, likelyLoad: true })), undefined);
  assert.equal(noRerunCause(facts(RED)), "the merged base is red");
  assert.equal(noRerunCause(facts({ ...RED, likelyLoad: true, notRun: "no sandbox" })), "the merged base could not be re-gated");
  assert.equal(noRerunCause(facts({ ...RED, notRun: "no sandbox" })), "the merged base could not be re-gated");
  assert.equal(noRerunCause(facts({ green: true, line: "lint=pass test=pass" })), undefined);
});

test("the next turn gates the base first only after a red verify judged likely load", () => {
  assert.equal(mustGateBase(facts({ ...RED, likelyLoad: true })), true);
  assert.equal(mustGateBase(facts(RED)), false);
  assert.equal(mustGateBase(facts({ green: true, line: "lint=pass test=pass", likelyLoad: true })), false);
  assert.equal(mustGateBase(facts({ ...RED, likelyLoad: true, notRun: "no sandbox" })), false);
  assert.equal(mustGateBase(facts(null)), false);
  assert.equal(mustGateBase(undefined), false);
});

const line = (run: string, phase: string, gates: Record<string, number>, ok = true, project = "fixture") =>
  JSON.stringify({ ts: `${run}Z`, run, project, issue: "", phase, ms: Object.values(gates).reduce((a, b) => a + b, 0), ok, gates });

test("typicalGateMs leaves out the oldest of six runs, which is outside the recent window", () => {
  const runs = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"];
  // The oldest run is slow; the five newest took 100 to 500 s. Six values would give the 75th percentile 500 s, five give 400 s.
  const secs = [9000, 100, 200, 300, 400, 500];
  const text = runs.map((run, i) => line(run, "base gates", { test: secs[i] * 1000 })).join("\n");
  assert.deepEqual(typicalGateMs(text, { name: "fixture" }), { test: 400_000 });
});

const TIMINGS = [
  line("2026-02-01", "base gates", { lint: 20_000, test: 300_000 }),
  line("2026-02-01", "verify", { lint: 21_000, test: 369_000 }),
  // Red lines say nothing of a gate's usual time, and another project's are no record of this one.
  line("2026-02-01", "verify", { lint: 20_000, test: 5_000_000 }, false),
  line("2026-02-01", "verify", { lint: 20_000, test: 5_000_000 }, true, "other"),
  "not json",
].join("\n");

test("typicalGateMs takes a gate's 75th percentile over green base gates and verify lines, and no such line gives no record", () => {
  assert.deepEqual(typicalGateMs(TIMINGS, { name: "fixture" }), { lint: 21_000, test: 369_000 });
  assert.deepEqual(typicalGateMs(line("2026-02-01", "verify", { test: 400_000 }, false), { name: "fixture" }), {});
  assert.deepEqual(typicalGateMs("", { name: "fixture" }), {});
});

test("with the typical times as its record, a red test gate of 1200 s is judged likely load and one of 600 s is not", () => {
  const recorded = typicalGateMs(TIMINGS, { name: "fixture" });
  const assertion = [{ name: "test", command: "run-tests", exitCode: 1, output: "FAILED tests/b.test.ts::b\nAssertionError: expected 1 to be 2" }];
  const gates = (ms: number) => [{ name: "lint", pass: true, ms: 20_000 }, { name: "test", pass: false, ms }];
  assert.equal(likelyLoad(assertion, gates(1_200_000), recorded), true);
  assert.equal(likelyLoad(assertion, gates(600_000), recorded), false);
  assert.equal(likelyLoad(assertion, gates(1_200_000), {}), false, "with no record only the timeouts rule judges");
});

test("the autonomy loop passes the base-gates option to the next turn and the burndown honours it over SKIP_BASE_GATES", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /const gateBase = mustGateBase\(lastFacts\);/);
  assert.match(cli, /The merged \$\{project\.baseBranch\} was red, likely load - this turn gates it again before any agent starts\./);
  assert.match(cli, /\.\.\.\(gateBase \? \{ forceBaseGates: true \} : \{\}\)/);
  const burndown = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(burndown, /SKIP_BASE_GATES === "1" && !turn\?\.forceBaseGates/);
  assert.match(burndown, /requireGreenBase\(gateProject, image, planFile, !turn\?\.forceBaseGates,/);
  assert.match(burndown, /typicalGateMs\(timingsText\(\), project\)/);
});
