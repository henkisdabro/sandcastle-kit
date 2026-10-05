// Whose red a failure is, where the base-red check could once get it wrong, through the pipeline and fakes
// of test/base-red-harness.ts: an id that names only a file, a landing between reading the base's tip and
// gating it, and a base with more failing tests than a summary shows. No Docker, model, gh or network.
//
//   pnpm exec tsx --test test/base-red-check.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { commit, git, GREEN, harness, red } from "./base-red-harness.ts";

/** node:test's spec output for failing tests, each `[file, name]`; a name equal to its file is a file that failed to load. */
const nodeTest = (failing: [string, string][], why: string) =>
  red(
    [
      ...failing.map(([, name]) => `✖ ${name} (1.2ms)`),
      `ℹ fail ${failing.length}`,
      "",
      "✖ failing tests:",
      "",
      ...failing.flatMap(([file, name]) => [`test at ${file}:1:1`, `✖ ${name} (1.2ms)`, `  ${why}`]),
    ].join("\n"),
  );

test("a branch that breaks one test in a file where the base has another red gets its repair: FAIL <file> alone is not the same failure", async () => {
  const base = red("FAIL  test/clock.test.ts > rolls over at midnight\n  AssertionError: expected 0 to be 24\n1 failed");
  const branch = red("FAIL  test/clock.test.ts > formats the hour\n  AssertionError: expected '9' to be '09'\n1 failed");
  const h = harness(() => [branch, GREEN], base);
  h.agents.repair = (id, wt) => commit(wt, `src/fix-${id}.ts`, "fix\n");
  const o = await h.attempt("1");
  assert.equal(h.baseRuns.length, 1);
  assert.deepEqual(h.repairs, ["1"]);
  assert.equal(o.status, "green");
  assert.deepEqual(h.toldRed, []);
});

test("a node:test file that fails to load on the branch for another reason than on the base gets its repair", async () => {
  const base = nodeTest([["test/clock.test.js", "test/clock.test.js"]], "Error: Cannot find module './tz.js'");
  const branch = nodeTest([["test/clock.test.js", "test/clock.test.js"]], "SyntaxError: Unexpected token '}'");
  const h = harness(() => [branch, GREEN], base);
  h.agents.repair = (id, wt) => commit(wt, `src/fix-${id}.ts`, "fix\n");
  const o = await h.attempt("1");
  assert.equal(h.baseRuns.length, 1);
  assert.deepEqual(h.repairs, ["1"]);
  assert.equal(o.status, "green");
});

test("a branch red the same way as the base, file-only id and all, starts no repair", async () => {
  const same = red("FAIL  test/clock.test.ts > rolls over at midnight\n  AssertionError: expected 0 to be 24\n1 failed");
  const h = harness(() => [same], same);
  const o = await h.attempt("1");
  assert.equal(o.status, "gate-failed");
  assert.deepEqual(h.repairs, []);
  assert.deepEqual(h.toldRed, [["test/clock.test.ts"]]);
});

test("a test named path::name that fails on the base too is the base's, whatever else either gate said", async () => {
  const base = nodeTest([["test/clock.test.js", "rolls over at midnight"], ["test/date.test.js", "parses"]], "AssertionError: 0 == 24");
  const branch = nodeTest([["test/clock.test.js", "rolls over at midnight"]], "AssertionError: 0 == 24");
  const h = harness(() => [branch], base);
  const o = await h.attempt("1");
  assert.equal(o.status, "gate-failed");
  assert.deepEqual(h.repairs, []);
  assert.deepEqual(h.toldRed, [["test/clock.test.js::rolls over at midnight"]]);
});

test("a landing between reading the base's tip and gating it files the run under the commit it gated", async () => {
  const clock = nodeTest([["test/clock.test.js", "rolls over at midnight"]], "AssertionError: 0 == 24");
  let landed = false;
  const h = harness(
    () => [clock],
    (root) => {
      // Another ticket lands after the first branch read the tip and before its base sandbox is cut.
      if (!landed) commit(root, "src/landed.ts", "landed\n");
      landed = true;
      return clock;
    },
  );
  const before = git(h.root, "rev-parse", "main");
  await h.attempt("1");
  const after = git(h.root, "rev-parse", "main");
  assert.notEqual(after, before);
  assert.deepEqual(h.baseRuns, [after], "the base run gated the landed commit");
  // The second branch reads the landed tip: the run of that very commit answers it, with no second base run.
  const o = await h.attempt("2");
  assert.equal(o.status, "gate-failed");
  assert.deepEqual(h.baseRuns, [after]);
  assert.deepEqual(h.repairs, []);
});

test("a branch's failing test sixth on a base with six red is still the base's", async () => {
  const six: [string, string][] = ["a", "b", "c", "d", "e", "f"].map((t) => [`test/${t}.test.js`, `case ${t}`]);
  const base = nodeTest(six, "AssertionError: 0 == 1");
  const branch = nodeTest([six[5]], "AssertionError: 0 == 1");
  const h = harness(() => [branch], base);
  const o = await h.attempt("1");
  assert.equal(o.status, "gate-failed");
  assert.deepEqual(h.repairs, [], "no repair pass on a failure the base has too");
  assert.deepEqual(h.toldRed, [["test/f.test.js::case f"]]);
});
