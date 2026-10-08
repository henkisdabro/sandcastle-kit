// A repair pass that commits nothing (the repairer judged the red a flake) is not counted as a repair:
// the pipeline's outcome keeps `repairs` for the passes that committed and `idleRepairs` for the others,
// and the per-ticket line says ` repaired=1` for the first and ` repair made no change` for the second.
// The count crosses a requeue, as the repair count does. Through test/base-red-harness.ts: a temp repo, a
// scripted agent and scripted gate runs; no Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-repair-no-change.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { GREEN, commit, harness, red } from "./base-red-harness.ts";

const { firstAttemptIdleRepairs } = await import("../src/landing.ts");
const { repairWords } = await import("../src/ledger.ts");

// A red on a test in a file the branch changed, so it is the branch's own and gets a repair pass.
const own = (id: string) => red(`FAIL  src/ticket-${id}.test.ts > works\n1 failed`);
const owning = () => {
  const h = harness((id) => [own(id), GREEN]);
  h.agents.impl = (id, wt) => commit(wt, `src/ticket-${id}.test.ts`, "x\n");
  return h;
};

test("a repair that commits is a repair, and says repaired=1", async () => {
  const h = owning();
  h.agents.repair = (id, wt) => commit(wt, `src/fix-${id}.ts`, "fix\n");
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1"]);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 1);
  assert.equal(o.idleRepairs ?? 0, 0);
  assert.equal(repairWords(o), " repaired=1");
});

test("a repair that commits nothing is not counted: the line says the repair made no change, never repaired=1", async () => {
  const h = owning();
  h.agents.repair = () => {};
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1"], "the pass ran");
  assert.equal(o.status, "green", "the gate came back green: a flake");
  assert.equal(o.repairs, 0);
  assert.equal(o.idleRepairs, 1);
  assert.equal(repairWords(o), " repair made no change");
  assert.doesNotMatch(repairWords(o), /repaired=/);
});

test("a ticket that never needed a repair says nothing of one", async () => {
  const h = harness(() => [GREEN]);
  const o = await h.attempt("1");
  assert.equal(o.repairs, 0);
  assert.equal(repairWords(o), "");
});

test("a repair pass that dies without committing is one that made no change too", async () => {
  const h = harness((id) => [own(id)]);
  h.agents.impl = (id, wt) => commit(wt, `src/ticket-${id}.test.ts`, "x\n");
  h.agents.repair = () => {
    throw new Error("agent exited");
  };
  const o = await h.attempt("1");
  assert.equal(o.status, "gate-failed");
  assert.equal(o.repairs, 0);
  assert.equal(o.idleRepairs, 1);
});

test("repairWords counts each kind apart, and says plurals", () => {
  assert.equal(repairWords({ repairs: 2 }), " repaired=2");
  assert.equal(repairWords({ repairs: 1, idleRepairs: 1 }), " repaired=1 repair made no change");
  assert.equal(repairWords({ repairs: 0, idleRepairs: 2 }), " 2 repairs made no change");
  assert.equal(repairWords({ repairs: 0, idleRepairs: 0 }), "");
});

test("a requeued ticket's second attempt starts from the first attempt's idle repairs, as it does its repairs", () => {
  const done = (issue: string, idleRepairs?: number): PromiseSettledResult<{ issue: string; idleRepairs?: number }> => ({ status: "fulfilled", value: { issue, idleRepairs } });
  assert.equal(firstAttemptIdleRepairs([done("1", 0), done("193", 1)], "193"), 1);
  assert.equal(firstAttemptIdleRepairs([done("193")], "193"), 0, "an outcome with no count counts 0");
  assert.equal(firstAttemptIdleRepairs([done("1", 2)], "193"), 0);
  assert.equal(firstAttemptIdleRepairs([{ status: "rejected", reason: new Error("x") }], "193"), 0);
});
