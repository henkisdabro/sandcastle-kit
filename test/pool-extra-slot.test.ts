// The extra slot (src/pool.ts `withExtraSlot`): the mid-run base check's sandbox, started inside a
// slot its run already holds, still shows in the machine pool - past the limit if need be - yet
// keeps no other process from a numbered slot, and goes when its holder ends or is killed.
// Holders are child processes that look like the kit to `ps`, as in test/pool-wait-order.test.ts.
//
//   node --test test/pool-extra-slot.test.ts

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";
import { startNode } from "./cli-spawn.ts";
import { everyPidIsTheKit } from "./kit-process.ts";

const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = cache;
process.env.SANDCASTLE_MAX_SANDBOXES = "1";
process.env.SANDCASTLE_MAX_GATES = "1";
const { inject, liveSlots, usage, withExtraSlot, withSlot } = await import("../src/pool.ts");
const { commandOf } = await import("../src/live-runs.ts");
// This process takes slots too, as a run would: `ps` would call it a test runner, not the kit.
inject({ probe: (pid) => (pid === process.pid ? everyPidIsTheKit() : commandOf(pid)) });

const pool = join(import.meta.dirname, "../src/pool.ts");
const slots = join(cache, "sandcastle-kit", "slots");
const locks = () => readdirSync(slots).filter((f) => f.endsWith(".lock"));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(ok(), "timed out");
};

/** A run holding the base check's extra sandbox slot until `release` is written in `dir`. */
const holder = (dir: string): { child: ChildProcess; exit: Promise<number | null> } => {
  const script =
    `globalThis.entry = ${JSON.stringify(RUN_COMMAND)};` +
    `const { withExtraSlot } = await import(${JSON.stringify(pool)});` +
    `const fs = await import("node:fs"); const dir = ${JSON.stringify(dir)};` +
    `await withExtraSlot("sandboxes", "fixture base check", async () => {` +
    `  fs.writeFileSync(dir + "/held", "");` +
    `  while (!fs.existsSync(dir + "/release")) await new Promise((r) => setTimeout(r, 25));` +
    `});`;
  const child = startNode(["--input-type=module", "-e", script], { timeoutMs: 240_000, stdio: ["ignore", "pipe", "pipe"] });
  return { child, exit: new Promise((resolve) => child.on("exit", (code) => resolve(code))) };
};

test("the base check's extra sandbox counts past the limit, blocks no slot, and goes when its holder ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-extra-"));
  const run = holder(dir);
  await until(() => existsSync(join(dir, "held")));

  assert.deepEqual(liveSlots("sandboxes").map((l) => l.label), ["fixture base check"]);
  assert.equal(usage(), "sandboxes 1/1 · gates 0/1");

  // The one numbered slot is still free: a ticket takes it at once, and the pool reads 2/1.
  const waited: string[] = [];
  const inside = await withSlot("sandboxes", "ticket", async () => [usage(), liveSlots("sandboxes").length], (why) => waited.push(why), 20);
  assert.deepEqual(inside, ["sandboxes 2/1 · gates 0/1", 2]);
  assert.deepEqual(waited, []);

  writeFileSync(join(dir, "release"), "");
  assert.equal(await run.exit, 0);
  assert.deepEqual(liveSlots("sandboxes"), []);
  assert.equal(usage(), "sandboxes 0/1 · gates 0/1");
  assert.deepEqual(locks(), []);
});

test("a killed holder's extra slot counts for nothing, and the next one taken removes its file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-extra-"));
  const run = holder(dir);
  await until(() => existsSync(join(dir, "held")));
  assert.equal(liveSlots("sandboxes").length, 1);

  run.child.kill("SIGKILL");
  await run.exit;
  assert.deepEqual(liveSlots("sandboxes"), []);
  assert.equal(usage(), "sandboxes 0/1 · gates 0/1");
  assert.equal(locks().length, 1, "a killed process ran no exit handler: its file is still there");

  const during = await withExtraSlot("sandboxes", "next base check", async () => liveSlots("sandboxes").length);
  assert.equal(during, 1, "only the new holder's slot");
  assert.deepEqual(locks(), []);
});
