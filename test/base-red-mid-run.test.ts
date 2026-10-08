// A test that goes red on the base mid-run, on branches that did not touch it, through the pipeline and
// fakes of test/base-red-harness.ts. No Docker, model, gh or network. No branch gets a repair pass for a
// failure the base has too, the base's gate runs once for all of them, and the closing summary names the
// test once.
//
//   pnpm test:file test/base-red-mid-run.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOCK, GREEN, commit, harness, red } from "./base-red-harness.ts";

const { render } = await import("../src/report.ts");

test("three branches red on one test none of them touched start no repair, the base gate runs once, and the summary names the test once", async () => {
  const h = harness(() => [CLOCK]);
  // console.log is swapped per attempt, so the three run one after another for the output lines and
  // together for the base run: the cache has to hold either way.
  const outcomes = [];
  for (const id of ["1", "2", "3"]) outcomes.push(await h.attempt(id));
  assert.deepEqual(outcomes.map((o) => o.status), ["gate-failed", "gate-failed", "gate-failed"]);
  assert.deepEqual(h.repairs, [], "no repair pass on a failure the base has too");
  assert.equal(h.baseRuns.length, 1, "one gate run on the base for all three");
  assert.deepEqual(h.lines.filter((l) => l.includes("base went red")), ["base went red mid-run: test/clock.test.ts"]);
  assert.deepEqual(h.toldRed, [["test/clock.test.ts"]]);

  const out = render({
    base: "main", tracker: "github", started: "2026-10-05T00:00:00.000Z", finished: "2026-10-05T00:10:00.000Z", live: false, dryRun: false,
    gateCount: 1, tickets: {}, runnable: [], blocked: [], standing: [], keptWorktrees: [], changed: {}, baseRed: h.toldRed.flat(),
  });
  assert.equal(out.split("base went red mid-run: test/clock.test.ts").length - 1, 1, "named once in the summary");
  const needsYou = out.split("\n").filter((l) => l.startsWith("- base went red mid-run"));
  assert.equal(needsYou.length, 1);
  assert.ok(out.indexOf(needsYou[0]) > out.indexOf("Needs you") && out.indexOf(needsYou[0]) < out.indexOf("Needs fixing"));
});

test("branches red on the base's test at the same moment share one base gate run", async () => {
  const h = harness(() => [CLOCK]);
  const outcomes = await Promise.all(["1", "2", "3"].map((id) => h.attempt(id)));
  assert.deepEqual(outcomes.map((o) => o.status), ["gate-failed", "gate-failed", "gate-failed"]);
  assert.deepEqual(h.repairs, []);
  assert.equal(h.baseRuns.length, 1);
});

test("a branch red on a test in a file it changed still gets its repair, with no base gate run", async () => {
  const h = harness((id) => [red(`FAIL  src/ticket-${id}.test.ts > works\n1 failed`), GREEN]);
  h.agents.impl = (id, wt) => commit(wt, `src/ticket-${id}.test.ts`, "x\n");
  h.agents.repair = (id, wt) => commit(wt, `src/fix-${id}.ts`, "fix\n");
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1"]);
  assert.equal(h.baseRuns.length, 0);
  assert.equal(o.status, "green");
});

test("a branch red on a test the base passes still gets its repair", async () => {
  const h = harness(() => [CLOCK, GREEN], GREEN);
  h.agents.repair = (id, wt) => commit(wt, `src/fix-${id}.ts`, "fix\n");
  const o = await h.attempt("1");
  assert.equal(h.baseRuns.length, 1);
  assert.deepEqual(h.repairs, ["1"]);
  assert.equal(o.status, "green");
  assert.deepEqual(h.toldRed, []);
});

test("a red whose test file the output does not name is the branch's own: it gets its repair, with no base gate run", async () => {
  const h = harness(() => [red("✖ rolls over at midnight (3.1ms)\nℹ fail 1"), GREEN]);
  h.agents.repair = (id, wt) => commit(wt, `src/fix-${id}.ts`, "fix\n");
  const o = await h.attempt("1");
  assert.equal(h.baseRuns.length, 0);
  assert.deepEqual(h.repairs, ["1"]);
  assert.equal(o.status, "green");
});
