// status.sh keeps its own bash check of "is this run live" (a node start on each redraw is too
// slow), so these tests hold it to the rule of mod/hooks/run-live.ts: the same match string, the
// same `ps` flags as the mod, and the same answers when it is run on a live, a recycled and a
// gone pid. No Docker, no model calls.
//
//   pnpm exec tsx --test test/run-live-contract.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";
import { kitLikeProcess } from "./kit-process.ts";

const root = join(import.meta.dirname, "..");
const status = readFileSync(join(root, "status.sh"), "utf8");
const mod = readFileSync(join(root, "mod/hooks/register.tsx"), "utf8");

/** status.sh's `run_alive` function, as text. */
const runAlive = () => status.match(/^run_alive\(\) \{\n[\s\S]*?\n\}$/m)?.[0] ?? "";

test("status.sh matches the same string as the module", () => {
  assert.equal(status.match(/^RUN_COMMAND="([^"]*)"$/m)?.[1], RUN_COMMAND, "status.sh's RUN_COMMAND drifted from mod/hooks/run-live.ts");
  assert.ok(runAlive().includes('*"$RUN_COMMAND"*'), "run_alive matches the command line against RUN_COMMAND");
});

test("status.sh and the mod read the command line with the same ps call", () => {
  assert.ok(runAlive().includes('ps -p "$1" -o command='), "run_alive reads `ps -p <pid> -o command=`");
  assert.ok(mod.includes('["ps", "-p", String(pid), "-o", "command="]'), "the mod's ps call");
});

test("no run's pid is judged by `kill -0` alone in status.sh", () => {
  // The slot locks (load_pool) are not runs: `slot_alive` falls back to a signal of 0 when `ps` cannot answer.
  const outsidePool = status.replace(/^load_pool\(\) \{[\s\S]*?\n\}$/m, "");
  assert.doesNotMatch(outsidePool, /kill -0 "\$pid"/);
});

/** What status.sh's `run_alive` says about a pid, by running the function itself. */
const shellSays = (pid: number) => spawnSync("bash", ["-c", `${status.match(/^RUN_COMMAND=.*$/m)?.[0]}\n${runAlive()}\nrun_alive ${pid}`], { stdio: ["ignore", "pipe", "pipe"] }).status === 0;

test("run_alive: the kit's process is live; a stranger, and a gone pid, are not", () => {
  const kit = kitLikeProcess();
  try {
    assert.equal(shellSays(kit.pid), true);
    assert.equal(shellSays(process.pid), false, "a live process that is not the kit: a recycled pid");
    const gone = spawnSync("true").pid!;
    assert.equal(shellSays(gone), false);
  } finally {
    kit.kill();
  }
});
