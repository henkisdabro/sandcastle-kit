// The machine pool's wait order (src/pool.ts): a freed slot goes to the run that has waited
// longest, across runs, for the sandbox pool and the gate pool alike; a wait entry or slot left
// by a dead run blocks nobody; a slot names its run. Runs are child processes that look like the
// kit to `ps`, as in test/lock.test.ts.
//
//   pnpm exec tsx --test test/pool-wait-order.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";
import { startNode } from "./cli-spawn.ts";
import { kitLikeProcess } from "./kit-process.ts";

const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = cache;
const { liveSlots, slotsByRun, usage } = await import("../src/pool.ts");

const pool = join(import.meta.dirname, "../src/pool.ts");
const slots = join(cache, "sandcastle-kit", "slots");
const waits = join(slots, "waits");
const deadPid = () => spawnSync("true").pid!;
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(ok(), "timed out");
};

/** A run: a process whose command line holds the kit's entry, with one slot of each pool. */
const run = (dir: string, body: string) => {
  const script =
    `globalThis.entry = ${JSON.stringify(RUN_COMMAND)};` +
    `const { withSlot } = await import(${JSON.stringify(pool)});` +
    `const fs = await import("node:fs"); const dir = ${JSON.stringify(dir)};` +
    `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));` +
    `const mark = (name) => fs.appendFileSync(dir + "/" + name, "x"); const has = (name) => fs.existsSync(dir + "/" + name);` +
    `const log = (line) => fs.appendFileSync(dir + "/log", line + "\\n");` +
    body;
  const child = startNode(["--input-type=module", "-e", script], {
    // Longer than the helper's 60 s: a child here lives as long as its test, which a busy machine stretches.
    timeoutMs: 240_000,
    env: { ...process.env, SANDCASTLE_MAX_SANDBOXES: "1", SANDCASTLE_MAX_GATES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return new Promise<void>((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(out)))));
};
const logOf = (dir: string) => readFileSync(join(dir, "log"), "utf8").trim().split("\n");

for (const name of ["sandboxes", "gates"]) {
  const P = JSON.stringify(name);

  test(`${name}: slots freed one by one go to the runs in the order they began waiting`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
    // The holder frees its slot once both have begun waiting. The younger wait polls far more
    // often, so only the order, not luck of timing, can give the older one the slot.
    const holder = run(dir, `await withSlot(${P}, "holder", async () => { mark("held"); while (!has("c-waits")) await sleep(25); });`);
    await until(() => existsSync(join(dir, "held")));
    const b = run(dir, `await withSlot(${P}, "b", async () => log("b"), () => mark("b-waits"), 400);`);
    await until(() => existsSync(join(dir, "b-waits")));
    const c = run(dir, `await withSlot(${P}, "c", async () => log("c"), () => mark("c-waits"), 20);`);
    await Promise.all([holder, b, c]);
    assert.deepEqual(logOf(dir), ["b", "c"]);
  });

  test(`${name}: the run that freed the slot does not take it back from a longer wait`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
    // Run A holds the slot and, while B waits, asks for a second; freeing the first, it asks again at once.
    const a = run(
      dir,
      `let second;
       await withSlot(${P}, "first", async () => {
         mark("held");
         while (!has("b-waits")) await sleep(25);
         second = withSlot(${P}, "second", async () => log("a second"), () => mark("second-waits"), 20);
         while (!has("second-waits")) await sleep(25);
       });
       await second;`,
    );
    await until(() => existsSync(join(dir, "held")));
    const b = run(dir, `await withSlot(${P}, "b", async () => log("b"), () => mark("b-waits"), 400);`);
    await Promise.all([a, b]);
    assert.deepEqual(logOf(dir), ["b", "a second"]);
  });

  test(`${name}: within one run nothing waits for another of its own`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
    await run(
      dir,
      `const waiter = (id) => withSlot(${P}, id, async () => log(id), undefined, 20);
       let both;
       await withSlot(${P}, "holder", async () => { both = Promise.all([waiter("w1"), waiter("w2")]); await sleep(200); });
       await both;`,
    );
    assert.deepEqual(logOf(dir).sort(), ["w1", "w2"]);
  });
}

test("a wait entry left by a dead run never blocks a live run, and is cleaned up", async () => {
  mkdirSync(waits, { recursive: true });
  writeFileSync(join(waits, `sandboxes-1-${deadPid()}.wait`), `${deadPid()} deadrun 1 killed run\n`);
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
  await run(dir, `await withSlot("sandboxes", "live", async () => log("got"), undefined, 20);`);
  assert.deepEqual(logOf(dir), ["got"]);
  assert.deepEqual(readdirSync(waits).filter((f) => f.endsWith(".wait")), []);
});

test("a slot lock left by a dead run is taken over, and a finished wait leaves no entry", async () => {
  mkdirSync(slots, { recursive: true });
  writeFileSync(join(slots, "gates-0.lock"), `${deadPid()} old-token run=deadrun killed run\n`);
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
  await run(dir, `await withSlot("gates", "live", async () => log("got"), undefined, 20);`);
  assert.deepEqual(logOf(dir), ["got"]);
  assert.deepEqual(readdirSync(waits).filter((f) => f.endsWith(".wait")), []);
});

test("a slot lock names its run, and the pool counts slots per live run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
  const holder = run(dir, `await withSlot("sandboxes", "named one", async () => { mark("held"); while (!has("release")) await sleep(25); });`);
  await until(() => existsSync(join(dir, "held")));
  const [lock] = liveSlots("sandboxes");
  assert.match(readFileSync(join(slots, "sandboxes-0.lock"), "utf8"), /^\d+ [0-9a-f-]+ run=[0-9a-f]{8} named one\n$/);
  assert.equal(lock.label, "named one");
  assert.deepEqual([...slotsByRun("sandboxes")], [[lock.run, 1]]);
  writeFileSync(join(dir, "release"), "");
  await holder;
  assert.deepEqual([...slotsByRun("sandboxes")], []);
});

test("slots are counted per run: several of one, a lock that names no run, a dead one ignored", () => {
  const kit = kitLikeProcess();
  const other = kitLikeProcess();
  try {
    mkdirSync(slots, { recursive: true });
    for (const f of readdirSync(slots)) if (f.endsWith(".lock")) writeFileSync(join(slots, f), "");
    writeFileSync(join(slots, "sandboxes-0.lock"), `${kit.pid} t1 run=aaaa one\n`);
    writeFileSync(join(slots, "sandboxes-1.lock"), `${kit.pid} t2 run=aaaa two words\n`);
    writeFileSync(join(slots, "sandboxes-2.lock"), `${other.pid} t3 an older kit's label\n`);
    writeFileSync(join(slots, "sandboxes-3.lock"), `${deadPid()} t4 run=cccc gone\n`);
    assert.deepEqual([...slotsByRun("sandboxes")].sort(), [["aaaa", 2], [`pid:${other.pid}`, 1]].sort());
    assert.match(usage(), /^sandboxes 3\/\d+ · gates 0\/\d+$/);
    // The status view reads the pid on the line's first field only.
    const shell = spawnSync("bash", ["-c", `eval "\$(sed -n '/^RUN_COMMAND=/p;/^slot_alive() {/,/^}/p;/^load_pool() {/,/^}/p' status.sh)"; load_pool; echo "$USED_sandboxes $USED_gates"`], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, XDG_CACHE_HOME: cache },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(shell.stdout.trim(), "3 0", shell.stderr);
  } finally {
    kit.kill();
    other.kill();
  }
});
