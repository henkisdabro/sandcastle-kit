// A repair pass's `<followup>` line reaches the run's follow-up book tagged with the red run's tests that it
// names (`FollowUp.tests`); an implement pass's line is never tagged. Through test/base-red-harness.ts: a temp
// repo, a scripted agent and scripted gate runs; no Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-repair-followup-tests.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { GREEN, commit, harness, red } from "./base-red-harness.ts";

const FLAKY = red("FAIL  src/ticket-1.test.ts > works\n1 failed");

test("a repair's follow-up naming the failing test carries its id; an implement follow-up carries none", async () => {
  const h = harness(() => [FLAKY, GREEN]);
  h.agents.impl = (id, wt) => {
    commit(wt, `src/ticket-${id}.test.ts`, "x\n");
    return "<followup>src/ticket-1.test.ts flakes - seen in the implement pass</followup>";
  };
  h.agents.repair = () => "<followup>Clock race - src/ticket-1.test.ts waits too short</followup>\n<followup>Unrelated lint rule - nothing to do with a test</followup>";
  const o = await h.attempt("1");
  assert.equal(o.status, "green");
  const by = (phase: string) => h.followUps.filter((f) => f.phase === phase);
  assert.deepEqual(by("implement").map((f) => f.tests), [undefined]);
  assert.deepEqual(by("repair").map((f) => [f.title, f.tests]), [
    ["Clock race", ["src/ticket-1.test.ts"]],
    ["Unrelated lint rule", undefined],
  ]);
});
