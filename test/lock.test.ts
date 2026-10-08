// The lock files behind the machine-wide slots and the run lock (src/pool.ts):
// a live lock is refused, a dead one is taken over, a release leaves someone
// else's lock alone, and many processes racing one stale lock get one winner.
//
//   pnpm test:file test/lock.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";
import { startNode } from "./cli-spawn.ts";
import { kitLikeProcess } from "./kit-process.ts";

// Importing pool.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { releaseLock, takeLock } = await import("../src/pool.ts");

const dir = mkdtempSync(join(tmpdir(), "sandcastle-lock-"));
// The pid of a process that has exited: a lock a killed run left behind.
const deadPid = () => spawnSync("true").pid!;

test("a lock held by a live process of the kit is refused, naming it", () => {
  const file = join(dir, "live.lock");
  const kit = kitLikeProcess();
  try {
    writeFileSync(file, `${kit.pid} someone-else other run\n`);
    assert.deepEqual(takeLock(file, "me"), { owner: kit.pid });
    assert.match(readFileSync(file, "utf8"), /someone-else/);
  } finally {
    kit.kill();
  }
});

test("a lock whose pid is gone is taken over", () => {
  const file = join(dir, "dead.lock");
  writeFileSync(file, `${deadPid()} old-token killed run\n`);
  const { mine } = takeLock(file, "me");
  assert.ok(mine?.startsWith(`${process.pid} `));
  assert.equal(readFileSync(file, "utf8"), mine);
});

test("a release removes only the lock it took", () => {
  const file = join(dir, "release.lock");
  const { mine } = takeLock(file, "me");
  assert.ok(mine);
  // Someone took it over since (this process was thought dead, say).
  writeFileSync(file, `${process.ppid} their-token their run\n`);
  releaseLock(file, mine);
  assert.match(readFileSync(file, "utf8"), /their-token/);
  writeFileSync(file, mine);
  releaseLock(file, mine);
  assert.ok(takeLock(file, "again").mine, "the lock was released");
});

test("eight processes racing one stale lock: exactly one takes it", async () => {
  const file = join(dir, "race.lock");
  writeFileSync(file, `${deadPid()} old-token killed run\n`);
  const pool = join(import.meta.dirname, "../src/pool.ts");
  // All start at the same instant, and stay alive until every one has
  // answered: a winner that exits early is a dead pid, fairly taken over.
  // Each looks like the kit to `ps` (its script holds the kit's entry, as a
  // run's command line does): any other owner's lock is a recycled pid's.
  const at = Date.now() + 3000;
  const script =
    `globalThis.entry = ${JSON.stringify(RUN_COMMAND)};` + // survives the transform, which drops a comment
    `const { takeLock } = await import(${JSON.stringify(pool)});` +
    `while (Date.now() < ${at}) {}` +
    `console.log(takeLock(${JSON.stringify(file)}, "racer").mine ? "won" : "lost");` +
    `await new Promise((r) => setTimeout(r, 3000));`;
  const racers = Array.from(
    { length: 8 },
    () =>
      new Promise<string>((resolve, reject) => {
        const child = startNode(["--input-type=module", "-e", script], { env: process.env });
        let out = "";
        child.stdout!.on("data", (d) => (out += d));
        child.stderr!.on("data", (d) => (out += d));
        child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out))));
      }),
  );
  const said = await Promise.all(racers);
  assert.equal(said.filter((s) => s === "won").length, 1, said.join(", "));
  assert.equal(said.filter((s) => s === "lost").length, 7, said.join(", "));
});
