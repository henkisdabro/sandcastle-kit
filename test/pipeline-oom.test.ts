// An agent pass the kernel killed for memory: the words reach the ticket's note (`agentFailure`, which keeps the error's first
// line), and a kill under a pass that returned (a test the agent started, not the agent) is one console line. Through
// test/base-red-harness.ts, whose fake sandbox answers `memory.events` from counters the test raises; no Docker, model, gh
// or network.
//
//   pnpm test:file test/pipeline-oom.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { GREEN, commit, harness } from "./base-red-harness.ts";

const { agentFailure } = await import("../src/agents.ts");

test("an implement pass killed at the sandbox's limit fails with the cause on its first line, which the ticket's note keeps", async () => {
  const h = harness(() => [GREEN]);
  h.agents.impl = () => {
    h.kernel.oom++;
    h.kernel.kills++;
    throw new Error("claude-code agent failed:\nexited with code 137: Killed");
  };
  const error = await h.attempt("1").then(
    () => assert.fail("the pass threw"),
    (e: unknown) => e,
  );
  assert.equal(agentFailure(error), "claude-code agent failed - out of memory: killed a process at the sandbox's limit (`memory` in the project config sets it)");
  assert.ok(h.lines.some((l) => l === "#1: the implement pass failed, out of memory: killed a process at the sandbox's limit (`memory` in the project config sets it)."), h.lines.join("\n"));
});

test("a kill under a pass that returned is said once, and the pass goes on", async () => {
  const h = harness(() => [GREEN]);
  h.agents.impl = (id, wt) => {
    h.kernel.kills++;
    commit(wt, `src/ticket-${id}.ts`, `${id}\n`);
  };
  const o = await h.attempt("1");
  assert.equal(o.status, "green");
  assert.deepEqual(h.lines.filter((l) => /out of memory/.test(l)), ["#1: during the implement pass, out of memory: the VM ran out and killed a process here (lower maxSandboxes, or give the VM more memory)."]);
});

test("a pass with no kill says nothing of memory", async () => {
  const h = harness(() => [GREEN]);
  await h.attempt("1");
  assert.ok(!h.lines.some((l) => /out of memory/.test(l)), h.lines.join("\n"));
});
