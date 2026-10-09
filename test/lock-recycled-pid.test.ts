// The run lock and the slot locks judge their owner as a run is judged: a process of the kit
// (its command line holds the kit's entry), not just a pid that exists. A killed run's pid
// comes round as some other process, and its lock would otherwise be held for as long as that
// lasts. When `ps` cannot say what a pid is, the lock is kept: a live run must never look gone.
// status.sh's slot count follows the same rule. No Docker, no model calls.
//
//   pnpm test:file test/lock-recycled-pid.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runNode } from "./cli-spawn.ts";
import { kitLikeProcess } from "./kit-process.ts";

// Importing pool.ts must not touch the real slots.
const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = cache;
const { holderRunning, takeLock, usage } = await import("../src/pool.ts");

const dir = mkdtempSync(join(tmpdir(), "sandcastle-lock-"));
const deadPid = () => spawnSync("true").pid!;
const slots = join(cache, "sandcastle-kit", "slots");

test("a lock held by a process that is not the kit (a recycled pid) is taken over", () => {
  const file = join(dir, "recycled.lock");
  // The test runner is a live process, and not the kit.
  writeFileSync(file, `${process.pid} old-token killed run\n`);
  const { mine, owner } = takeLock(file, "me");
  assert.equal(owner, undefined);
  assert.ok(mine, "the recycled pid's lock was taken over");
  assert.equal(readFileSync(file, "utf8"), mine);
});

test("a lock held by a process of the kit is kept", () => {
  const file = join(dir, "kit.lock");
  const kit = kitLikeProcess();
  try {
    writeFileSync(file, `${kit.pid} token run\n`);
    assert.deepEqual(takeLock(file, "me"), { owner: kit.pid });
  } finally {
    kit.kill();
  }
});

test("holderRunning: when ps cannot answer for a pid that exists, the lock is kept", () => {
  assert.equal(holderRunning(process.pid, () => undefined), true, "no answer, process exists: trust the signal");
  assert.equal(holderRunning(deadPid(), () => undefined), false, "no answer, process gone");
  assert.equal(holderRunning(process.pid, () => "node /somewhere/else.js"), false, "an answer that is not the kit");
  assert.equal(holderRunning(process.pid, () => "node /kit/src/cli.ts run"), true);
  assert.equal(holderRunning(0, () => "node src/cli.ts"), false);
  assert.equal(holderRunning(NaN, () => "node src/cli.ts"), false);
});

test("a ps that fails keeps the lock of a live owner, end to end", () => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-noPs-"));
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "ps"), 0o755);
  const file = join(dir, "no-ps.lock");
  writeFileSync(file, `${process.pid} token run\n`);
  const pool = join(import.meta.dirname, "../src/pool.ts");
  const script = `const { takeLock } = await import(${JSON.stringify(pool)}); console.log(JSON.stringify(takeLock(${JSON.stringify(file)}, "me")));`;
  const out = runNode(["--input-type=module", "-e", script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { owner, mine } = JSON.parse(out.stdout.trim().split("\n").pop()!);
  assert.equal(mine, undefined, out.stderr);
  assert.ok(Number.isInteger(owner), "the lock's owner exists, and ps could not say otherwise");
});

test("slots: a recycled pid is not a used slot, a process of the kit is", () => {
  mkdirSync(slots, { recursive: true });
  const kit = kitLikeProcess();
  try {
    writeFileSync(join(slots, "sandboxes-0.lock"), `${kit.pid} token a\n`);
    writeFileSync(join(slots, "sandboxes-1.lock"), `${process.pid} token b\n`);
    writeFileSync(join(slots, "gates-0.lock"), `${deadPid()} token c\n`);
    assert.match(usage(), /^sandboxes 1\/\d+ · gates 0\/\d+$/);
    const shell = spawnSync("bash", ["-c", `eval "$(sed -n '/^RUN_COMMAND=/p;/^slot_alive() {/,/^}/p;/^load_pool() {/,/^}/p' status.sh)"; load_pool; echo "$USED_sandboxes $USED_gates"`], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, XDG_CACHE_HOME: cache },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(shell.stdout.trim(), "1 0", shell.stderr);
  } finally {
    kit.kill();
  }
});

test("status.sh slot_alive: ps that cannot answer keeps a live owner", () => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-noPs-"));
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "ps"), 0o755);
  const run = (pid: number) =>
    spawnSync("bash", ["-c", `eval "$(sed -n '/^RUN_COMMAND=/p;/^slot_alive() {/,/^}/p' status.sh)"; slot_alive ${pid}`], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    }).status;
  assert.equal(run(process.pid), 0, "exists, ps silent: counted");
  assert.notEqual(run(deadPid()), 0, "gone: not counted");
});
