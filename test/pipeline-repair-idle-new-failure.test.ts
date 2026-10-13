// The extra repair pass for a new failure (a repair can break another test) goes to a ticket whose last pass
// committed. A pass that changed nothing did not cause the new red, so with the configured passes used up the
// ticket ends red. The harness repairs once (`repair: 1`); see test/pipeline-repair-no-change.test.ts.
//
//   pnpm test:file test/pipeline-repair-idle-new-failure.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { GREEN, commit, harness, red } from "./base-red-harness.ts";

const first = (id: string) => red(`FAIL  src/ticket-${id}.test.ts > works\n1 failed`);
const other = (id: string) => red(`FAIL  src/ticket-${id}.test.ts > another test\n1 failed`);
const owning = (gates: (id: string) => ReturnType<typeof red>[]) => {
  const h = harness((id) => gates(id));
  h.agents.impl = (id, wt) => commit(wt, `src/ticket-${id}.test.ts`, "x\n");
  return h;
};

test("an idle repair pass followed by a red on another test gets no second repair pass", async () => {
  const h = owning((id) => [first(id), other(id)]);
  h.agents.repair = () => {};
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1"], "one pass only");
  assert.equal(o.status, "gate-failed");
  assert.equal(o.idleRepairs, 1);
});

test("a repair pass that commits, followed by a red on another test, still gets its extra pass", async () => {
  const h = owning((id) => [first(id), other(id), GREEN]);
  h.agents.repair = (id, wt) => commit(wt, `src/fix-${id}-${h.repairs.length}.ts`, "fix\n");
  const o = await h.attempt("1");
  assert.deepEqual(h.repairs, ["1", "1"], "the extra pass ran");
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 2);
});
