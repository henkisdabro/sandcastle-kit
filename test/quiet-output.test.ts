// A green suite's output carries no FAIL or WARNING line of the kit's own making: the tests that
// drive gate and lean output capture it, so a person grepping a gate log for `FAIL` finds real
// failures only.
//
//   pnpm exec tsx --test test/quiet-output.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const kit = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

for (const file of ["test/land-command.test.ts", "test/lean.test.ts"]) {
  test(`${file} prints no FAIL or WARNING line`, () => {
    // Inside a test run, NODE_TEST_CONTEXT makes a nested run hand its output to the parent; drop it
    // so the child prints as it would on its own.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [tsx, "--test", file], { cwd: kit, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const noisy = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => /^[#\s]*(FAIL|WARNING)/.test(l));
    assert.deepEqual(noisy, []);
  });
}
