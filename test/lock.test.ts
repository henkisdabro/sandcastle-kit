// The lock files behind the machine-wide slots and the run lock (src/pool.ts):
// a live lock is refused, a dead one is taken over, a release leaves someone
// else's lock alone, and many processes racing one stale lock get one winner.
//
//   pnpm test:file test/lock.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // The racers meet at files, not at a clock instant: a racer whose node starts
  // slowly under load is waited for, never late. Each writes ready-<n> once
  // takeLock is imported and waits for `go`; after answering it waits for `done`,
  // so a winner never exits early (a dead pid is fairly taken over).
  const barrier = mkdtempSync(join(tmpdir(), "sandcastle-barrier-"));
  const LIMIT_MS = 60_000;
  // Each looks like the kit to `ps` (its script holds the kit's entry, as a
  // run's command line does): any other owner's lock is a recycled pid's.
  const script =
    `globalThis.entry = ${JSON.stringify(RUN_COMMAND)};` + // survives the transform, which drops a comment
    `import { existsSync, writeFileSync } from "node:fs";` +
    `const { takeLock } = await import(${JSON.stringify(pool)});` +
    `const nap = new Int32Array(new SharedArrayBuffer(4));` +
    `const waitFor = (name) => {` +
    `  const from = performance.now();` +
    `  while (!existsSync(${JSON.stringify(barrier)} + "/" + name)) {` +
    `    if (performance.now() - from > ${LIMIT_MS}) { console.error("gave up waiting for " + name); process.exit(1); }` +
    `    Atomics.wait(nap, 0, 0, 5);` +
    `  }` +
    `};` +
    `writeFileSync(${JSON.stringify(barrier)} + "/ready-" + process.argv.at(-1), "");` +
    `waitFor("go");` +
    `console.log(takeLock(${JSON.stringify(file)}, "racer").mine ? "won" : "lost");` +
    `waitFor("done");`;
  const children = Array.from({ length: 8 }, (_, n) =>
    startNode(["--input-type=module", "-e", script, String(n)], { env: process.env, timeoutMs: LIMIT_MS * 2 }),
  );
  let early = ""; // a racer that ends before `done` is written has failed
  const answers = children.map(
    (child) =>
      new Promise<string>((resolve) => {
        let out = "";
        child.stderr!.on("data", (d) => (out += d));
        child.stdout!.on("data", (d) => {
          out += d;
          if (out.includes("\n")) resolve(out.split("\n")[0]!);
        });
        child.on("exit", (code) => {
          if (!existsSync(join(barrier, "done"))) early ||= `a racer ended with ${code} before the others had answered: ${out.trim()}`;
          resolve(out.trim());
        });
      }),
  );
  const exits = children.map((child) => new Promise<number | null>((resolve) => child.on("exit", resolve)));
  // Polls (async, 10 ms) until `ready` is true; fails naming `what` and `count`.
  const until = async (ready: () => boolean, what: string, count: () => number) => {
    const from = performance.now();
    while (!ready()) {
      assert.equal(early, "", early);
      assert.ok(performance.now() - from < LIMIT_MS, `${what}: ${count()} of 8 arrived in ${LIMIT_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const arrived = () => readdirSync(barrier).filter((f) => f.startsWith("ready-")).length;
    await until(() => arrived() === 8, "racers ready", arrived);
    writeFileSync(join(barrier, "go"), "");
    let answered = 0;
    answers.forEach((a) => a.then(() => answered++));
    await until(() => answered === 8, "racers answered", () => answered);
    assert.equal(early, "", early);
    writeFileSync(join(barrier, "done"), "");
    const codes = await Promise.all(exits);
    const said = await Promise.all(answers);
    assert.deepEqual(codes, Array(8).fill(0), said.join(", "));
    assert.equal(said.filter((s) => s === "won").length, 1, said.join(", "));
    assert.equal(said.filter((s) => s === "lost").length, 7, said.join(", "));
  } finally {
    writeFileSync(join(barrier, "done"), ""); // lets a racer still waiting end by itself
    for (const child of children) child.kill("SIGKILL");
  }
});
