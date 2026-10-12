// A repair pass that judges the red outside its branch says so with `<verdict>outside-branch</verdict>` and a
// `Flaky:` line. When it also committed nothing, the pipeline runs the gate once and starts no further pass,
// even with repair attempts left: green goes on, red ends the ticket red with the line in its note, and the
// tests are on the outcome for the run record's `flaky` list. A tag on a pass that committed is ignored.
// Through test/base-red-harness.ts: a temp repo, a scripted agent and scripted gate runs; no Docker, model, gh
// or network.
//
//   pnpm test:file test/pipeline-repair-verdict.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { GREEN, commit, harness, red } from "./base-red-harness.ts";

const { describe } = await import("../src/ledger.ts");

const first = (id: string) => red(`FAIL  src/ticket-${id}.test.ts > works\n1 failed`);
const SAID = "Not this branch's.\n<verdict>outside-branch</verdict>\nFlaky: src/ticket-1.test.ts > works; src/other.test.ts > slow\n<promise>COMPLETE</promise>";
// Three repair attempts, so nothing but the verdict keeps a second pass from running after the first.
const owning = (gates: (id: string) => ReturnType<typeof red>[]) => {
  const h = harness(gates, undefined, undefined, 3);
  h.agents.impl = (id, wt) => commit(wt, `src/ticket-${id}.test.ts`, "x\n");
  return h;
};

test("a verdict with no commit is followed by one gate run and no second pass; green goes on", async () => {
  const h = owning((id) => [first(id), GREEN]);
  h.agents.repair = () => SAID;
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1"], "one model pass");
  assert.equal(o.status, "green");
  assert.deepEqual(o.outside, { line: "src/ticket-1.test.ts > works; src/other.test.ts > slow", tests: ["src/ticket-1.test.ts > works", "src/other.test.ts > slow"] });
});

test("a verdict with no commit and a red gate ends the ticket red, the line in its note, with no second pass", async () => {
  const h = owning((id) => [first(id), first(id)]);
  h.agents.repair = () => SAID;
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1"], "one model pass");
  assert.equal(o.status, "gate-failed");
  const said = describe({ kind: "pipeline", outcome: o, attempts: 1 }, { base: "main", gateNames: "test" });
  assert.match(said.record?.note ?? "", /test red.*outside this branch: src\/ticket-1\.test\.ts > works; src\/other\.test\.ts > slow/);
});

test("a red with no verdict still gets its further passes", async () => {
  const h = owning((id) => [first(id), first(id), first(id), first(id)]);
  h.agents.repair = () => "I could not fix it.";
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1", "1", "1"]);
  assert.equal(o.status, "gate-failed");
  assert.equal(o.outside, undefined);
});

test("the tag on a pass that committed is ignored: the pass is a repair as ever", async () => {
  const h = owning((id) => [first(id), first(id), GREEN]);
  h.agents.repair = (id, wt) => {
    commit(wt, `src/fix-${id}-${h.repairs.length}.ts`, "fix\n");
    return SAID;
  };
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1", "1"], "the second pass ran");
  assert.equal(o.status, "green");
  assert.equal(o.outside, undefined);
  assert.equal(o.repairs, 2);
});

test("a placeholder or a different verdict is no verdict", async () => {
  const h = owning((id) => [first(id), first(id), GREEN]);
  h.agents.repair = () => "<verdict>fixed</verdict>";
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1", "1"]);
  assert.equal(o.outside, undefined);
});
