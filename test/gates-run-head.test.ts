// Every ticket gate run records the commit it gated (`GateRun.head`), the re-run and the third run of a red gate on the
// red run's own head: `rememberFailed` keeps a flake that went green on the same head and drops a test a repair commit fixed.
// The pool is real (test/pool-sim.ts); the sandbox is a fake. No Docker, model or network.
//
//   pnpm test:file test/gates-run-head.test.ts

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup } from "./pool-sim.ts";

const { runGates } = await import("../src/gates.ts");

afterEach(cleanup);

const project = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }, { name: "test", command: "run-tests" }] } as Parameters<typeof runGates>[0];
const HEAD = "a".repeat(40);

const sandbox = (head: string | undefined, redTimes: number) => {
  let red = redTimes;
  return {
    exec: async (cmd: string) => {
      if (cmd.includes("git rev-parse HEAD")) return { exitCode: head ? 0 : 1, stdout: `${head ?? ""}\n`, stderr: "" };
      const fails = cmd.includes("run-tests") && red > 0;
      if (fails) red--;
      return { exitCode: fails ? 1 : 0, stdout: "", stderr: fails ? "boom" : "" };
    },
  };
};

test("a gate run records the commit it gated, and its in-slot re-run is on the same one", async () => {
  const result = await runGates(project, sandbox(HEAD, 1), "fixture gates", false, {}, false, undefined, true);
  assert.equal(result.head, HEAD);
  assert.equal(result.rerunOf?.head, HEAD);
  assert.equal(result.failure, undefined);
});

test("a sandbox that names no commit leaves the run with no head", async () => {
  const result = await runGates(project, sandbox(undefined, 0), "fixture gates");
  assert.equal("head" in result, false);
});
