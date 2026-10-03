// The machine pool's shares (src/pool.ts, docs/adr/0001): live runs split the sandbox slots
// equally between them, up to each run's demand. A run above its share takes no new slot while
// another run below its own waits, and never loses one it holds; a dead run's registration is
// ignored; a run with slots and no registration is an older kit's, counted at its concurrency.
// Runs are child processes that look like the kit to `ps`, as in test/pool-wait-order.test.ts.
//
//   pnpm exec tsx --test test/pool-shares.test.ts

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";
import { kitLikeProcess } from "./kit-process.ts";

const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = cache;
process.env.SANDCASTLE_MAX_SANDBOXES = "6";
const { members, slotsByRun, splitShares } = await import("../src/pool.ts");

const tsx = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs");
const pool = join(import.meta.dirname, "../src/pool.ts");
const slots = join(cache, "sandcastle-kit", "slots");
const registrations = join(slots, "runs");
const deadPid = () => spawnSync("true").pid!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Returns at the first look that holds: the counts of runs that take and free slots all the time are
// only right at some instants, and looking again could miss it.
const until = async (ok: () => boolean, what = "the condition") => {
  for (let i = 0; i < 800; i++) {
    if (ok()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
};

// A test that fails leaves its runs going, holding slots against every test after it.
const runs: (() => void)[] = [];
afterEach(() => {
  for (const kill of runs.splice(0)) kill();
  rmSync(slots, { recursive: true, force: true });
});

/** What a run's workers do: `workers` tickets, each holding a slot until a `stop` file appears. */
const holding = (project: string, demand: number, workers: number) =>
  `joinPool(${JSON.stringify(project)}, ${workers}, ${demand});
   await Promise.all(Array.from({ length: ${workers} }, () => withSlot("sandboxes", ${JSON.stringify(project)}, async () => { while (!has("stop")) await sleep(25); }, undefined, 25)));`;

/** A run: a process whose command line holds the kit's entry, running `body` with the pool's API in scope. */
const run = (dir: string, body: string) => {
  const script =
    `globalThis.entry = ${JSON.stringify(RUN_COMMAND)};` +
    `const { withSlot, joinPool, setDemand } = await import(${JSON.stringify(pool)});` +
    `const fs = await import("node:fs"); const dir = ${JSON.stringify(dir)};` +
    `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));` +
    `const mark = (name) => fs.appendFileSync(dir + "/" + name, "x"); const has = (name) => fs.existsSync(dir + "/" + name);` +
    `const log = (line) => fs.appendFileSync(dir + "/log", line + "\\n");` +
    body;
  const child = spawn(process.execPath, [tsx, "--input-type=module", "-e", script], {
    env: { ...process.env, SANDCASTLE_MAX_SANDBOXES: "6", SANDCASTLE_MAX_GATES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group: tsx runs the script in a child, and killing the wrapper alone leaves that child holding slots.
    detached: true,
  });
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* gone already */
    }
  };
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise<void>((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(out)))));
  // A failure is reported where it is awaited; an unwatched one must not end the test run.
  done.catch(() => {});
  runs.push(kill);
  return { done, kill };
};
const tmp = () => mkdtempSync(join(tmpdir(), "sandcastle-shares-"));
const heldBy = () => [...slotsByRun("sandboxes").values()].sort();
/** The counts hold for a stretch of time, not only for an instant between two tickets. */
const holds = async (ok: () => boolean, ms = 1200) => {
  for (let t = 0; t < ms; t += 50) {
    assert.ok(ok(), `held ${heldBy()} at ${t} ms: ${JSON.stringify(members())}`);
    await sleep(50);
  }
};
const registered = (run: string, pid: number, demand: number, since = Date.now()) => {
  mkdirSync(registrations, { recursive: true });
  writeFileSync(join(registrations, `${run}.run`), JSON.stringify({ pid, run, project: run, demand, concurrency: demand, since, shares: true }) + "\n");
};

test("the split: equal parts, none above its demand, the rest to the others, the odd slot to the earlier run", () => {
  const split = (total: number, demands: number[]) => {
    const shares = splitShares(total, demands.map((demand, i) => ({ run: `r${i}`, demand, since: i })));
    return demands.map((_, i) => shares.get(`r${i}`));
  };
  assert.deepEqual(split(6, [5, 5]), [3, 3]);
  assert.deepEqual(split(5, [5, 5]), [3, 2]);
  assert.deepEqual(split(6, [1, 5]), [1, 5]);
  assert.deepEqual(split(6, [5, 1]), [5, 1]);
  assert.deepEqual(split(6, [2, 5, 5]), [2, 2, 2]);
  assert.deepEqual(split(6, [1, 2, 9]), [1, 2, 3]);
  assert.deepEqual(split(6, [2, 2]), [2, 2], "the pool is not handed out beyond every demand");
  assert.deepEqual(split(6, [4]), [4]);
  assert.deepEqual(split(6, [0, 5]), [0, 5], "a drained run has no share");
  assert.deepEqual(split(2, [5, 5, 5]), [1, 1, 0]);
});

test("two runs wanting 5 each on a pool of 6 settle at 3 + 3", async () => {
  const dir = tmp();
  // A fills 5 slots alone. Its first two tickets finish and its workers ask again at once - the
  // way a run starts its next ticket - while B, which joined meanwhile, waits for 5.
  const a = run(
    dir,
    `joinPool("alpha", 5, 5);
     await Promise.all(Array.from({ length: 5 }, async (_, i) => {
       await withSlot("sandboxes", "a" + i, async () => { while (!has("stop") && !has("release" + i)) await sleep(25); }, undefined, 25);
       while (!has("stop")) await withSlot("sandboxes", "a" + i + " again", async () => { while (!has("stop")) await sleep(25); }, undefined, 25);
     }));`,
  );
  await until(() => heldBy().join() === "5", "run A to fill its demand alone");
  const b = run(dir, `joinPool("beta", 5, 5); await Promise.all(Array.from({ length: 5 }, (_, i) => withSlot("sandboxes", "b" + i, async () => { while (!has("stop")) await sleep(25); }, undefined, 25)));`);
  await until(() => members().length === 2 && members().every((m) => m.registered), "run B to register");
  for (const i of [0, 1]) writeFileSync(join(dir, `release${i}`), "");
  await until(() => heldBy().join() === "3,3", "the pool to settle at 3 + 3");
  // A's two new tickets wait, B's two surplus ones wait: neither run is above 3 for as long as we look.
  await holds(() => heldBy().join() === "3,3");
  assert.deepEqual(members().map((m) => m.share), [3, 3]);
  writeFileSync(join(dir, "stop"), "");
  await Promise.all([a.done, b.done]);
});

test("a run wanting 1 leaves 5 to the other", async () => {
  const dir = tmp();
  const small = run(dir, holding("small", 1, 1));
  const big = run(dir, holding("big", 5, 5));
  await until(() => heldBy().join() === "1,5", "1 + 5");
  await holds(() => heldBy().join() === "1,5");
  writeFileSync(join(dir, "stop"), "");
  await Promise.all([small.done, big.done]);
});

test("a run over its share takes no new slot while another waits, and keeps every slot it holds", async () => {
  const dir = tmp();
  // A holds all six, each until its own file appears; when the first goes it asks for a slot again at once.
  const a = run(
    dir,
    `joinPool("alpha", 7, 7);
     const held = Array.from({ length: 6 }, (_, i) => withSlot("sandboxes", "a" + i, async () => { mark("held" + i); while (!has("release" + i)) await sleep(25); }, undefined, 25));
     held[0].then(() => withSlot("sandboxes", "a again", async () => log("a again"), undefined, 25)).then(() => mark("again-done"));
     await Promise.all(held); while (!has("stop")) await sleep(25);`,
  );
  await until(() => heldBy().join() === "6", "run A to hold the whole pool");
  const b = run(dir, `joinPool("beta", 5, 5); await Promise.all(Array.from({ length: 5 }, (_, i) => withSlot("sandboxes", "b" + i, async () => { log("b" + i); while (!has("stop")) await sleep(25); }, () => mark("b-waits"), 25)));`);
  await until(() => existsSync(join(dir, "b-waits")), "run B to wait");
  // B is below its share (3), A above its own: nothing is taken from A.
  await sleep(300);
  assert.deepEqual(heldBy(), [6]);
  // A frees one slot and asks again: B has the slot, not A.
  writeFileSync(join(dir, "release0"), "");
  await until(() => existsSync(join(dir, "log")), "run B to take the slot");
  await sleep(600);
  assert.deepEqual(readFileSync(join(dir, "log"), "utf8").trim().split("\n").length, 1);
  assert.ok(!existsSync(join(dir, "again-done")), "A did not take the freed slot back");
  assert.deepEqual(heldBy(), [1, 5]);
  for (const i of [1, 2]) writeFileSync(join(dir, `release${i}`), "");
  await until(() => heldBy().join() === "3,3", "B to have its share");
  writeFileSync(join(dir, "stop"), "");
  for (const i of [3, 4, 5]) writeFileSync(join(dir, `release${i}`), "");
  await Promise.all([a.done, b.done]);
});

test("a run between two of its tickets keeps its share: another run leaves those free slots alone", async () => {
  const dir = tmp();
  // A live run that wants 3 and holds none at this instant: no wait entry, only its registration.
  const idle = kitLikeProcess();
  try {
    registered("idle", idle.pid, 3);
    const a = run(
      dir,
      `joinPool("alpha", 6, 6);
       await Promise.all(Array.from({ length: 6 }, (_, i) => withSlot("sandboxes", "a" + i, async () => { while (!has("stop")) await sleep(25); }, (why) => mark("why-" + why), 25)));`,
    );
    await until(() => heldBy().join() === "3", "run A to take its share");
    await until(() => existsSync(join(dir, "why-share")), "run A to say it waits for its share");
    // Three slots stay free: they are the other run's share, not anyone's to take.
    await holds(() => heldBy().join() === "3", 600);
    // A drained run (demand 0) wants nothing: with no one else wanting one, a free slot is taken as before.
    registered("idle", idle.pid, 0);
    await until(() => heldBy().join() === "6", "run A to take the slots no one wants");
    writeFileSync(join(dir, "stop"), "");
    await a.done;
  } finally {
    idle.kill();
  }
});

test("an older wait of a run above its share does not hold back a run below its own", async () => {
  const dir = tmp();
  // A holds the whole pool and has a seventh ticket waiting before B arrives.
  const a = run(
    dir,
    `joinPool("alpha", 7, 7);
     const held = Array.from({ length: 6 }, (_, i) => withSlot("sandboxes", "a" + i, async () => { mark("held" + i); while (!has("release" + i) && !has("stop")) await sleep(25); }, undefined, 25));
     while (!Array.from({ length: 6 }, (_, i) => has("held" + i)).every(Boolean)) await sleep(25);
     const seventh = withSlot("sandboxes", "a6", async () => log("a6"), () => mark("a6-waits"), 25);
     await Promise.all([...held, seventh]);`,
  );
  await until(() => existsSync(join(dir, "a6-waits")), "A's seventh ticket to wait");
  const b = run(dir, `joinPool("beta", 5, 5); await Promise.all(Array.from({ length: 5 }, (_, i) => withSlot("sandboxes", "b" + i, async () => { log("b" + i); while (!has("stop")) await sleep(25); }, () => mark("b-waits"), 25)));`);
  await until(() => existsSync(join(dir, "b-waits")), "run B to wait");
  // The slot A frees goes to B, below its share, though A's seventh has waited longer.
  writeFileSync(join(dir, "release0"), "");
  await until(() => existsSync(join(dir, "log")), "a run to take the freed slot");
  assert.match(readFileSync(join(dir, "log"), "utf8"), /^b\d\n$/);
  writeFileSync(join(dir, "stop"), "");
  await Promise.all([a.done, b.done]);
});

test("when one run ends, the other takes the whole pool", async () => {
  const dir = tmp();
  // A holds the pool, three of its tickets finish and are not replaced (it is above its share
  // while B waits), and the rest hold until A ends.
  const a = run(
    dir,
    `joinPool("alpha", 6, 6);
     await Promise.all(Array.from({ length: 6 }, (_, i) => withSlot("sandboxes", "a" + i, async () => { while (!has("stop-a") && !(i < 3 && has("release" + i))) await sleep(25); }, undefined, 25)));`,
  );
  await until(() => heldBy().join() === "6", "run A to fill the pool");
  const b = run(dir, `joinPool("beta", 6, 6); await Promise.all(Array.from({ length: 6 }, (_, i) => withSlot("sandboxes", "b" + i, async () => { while (!has("stop")) await sleep(25); }, undefined, 25)));`);
  for (const i of [0, 1, 2]) writeFileSync(join(dir, `release${i}`), "");
  await until(() => heldBy().join() === "3,3", "3 + 3");
  await holds(() => heldBy().join() === "3,3");
  writeFileSync(join(dir, "stop-a"), "");
  await a.done;
  await until(() => heldBy().join() === "6", "run B to take the whole pool");
  writeFileSync(join(dir, "stop"), "");
  await b.done;
});

test("a dead run's registration is ignored, and removed", async () => {
  const dir = tmp();
  registered("deadrun", deadPid(), 6, 1);
  const b = run(dir, holding("beta", 6, 6));
  await until(() => heldBy().join() === "6", "run B to take the whole pool");
  assert.ok(!existsSync(join(registrations, "deadrun.run")), "the dead registration was removed");
  writeFileSync(join(dir, "stop"), "");
  await b.done;
});

test("a run with slots and no registration is counted at its concurrency, or at the slots it holds", () => {
  const registeredRun = kitLikeProcess();
  const older = kitLikeProcess();
  try {
    mkdirSync(slots, { recursive: true });
    for (const f of readdirSync(slots)) if (f.endsWith(".lock")) writeFileSync(join(slots, f), "");
    for (const f of existsSync(registrations) ? readdirSync(registrations) : []) writeFileSync(join(registrations, f), "");
    registered("newrun", registeredRun.pid, 6);
    // An older kit's slot, with no run id and no registration.
    writeFileSync(join(slots, "sandboxes-0.lock"), `${older.pid} t1 an older kit's label\n`);
    // Its run record says it runs 4 at a time; the live-runs directory leads to it.
    const root = tmp();
    mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
    const record = join(root, ".sandcastle/logs/run.json");
    writeFileSync(record, JSON.stringify({ pid: older.pid, concurrency: 4 }));
    const runs = join(cache, "sandcastle-kit", "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "older"), root);

    const [old, mine] = [members().find((m) => !m.registered)!, members().find((m) => m.registered)!];
    assert.equal(old.demand, 4, "its concurrency, though it holds one slot");
    assert.equal(old.held, 1);
    assert.equal(old.share, 3);
    assert.equal(mine.share, 3, "the older run's wish takes its part of the pool");

    // A record that cannot be read: the slots it holds stand in.
    writeFileSync(record, "not json");
    assert.equal(members().find((m) => !m.registered)!.demand, 1);
    writeFileSync(join(slots, "sandboxes-1.lock"), `${older.pid} t2 another label\n`);
    const unread = members();
    assert.equal(unread.find((m) => !m.registered)!.demand, 2);
    assert.deepEqual(unread.map((m) => m.share).sort(), [2, 4]);
  } finally {
    registeredRun.kill();
    older.kill();
  }
});

test("a registration is written whole, names its run, and is removed with it", async () => {
  const dir = tmp();
  const before = new Set(existsSync(registrations) ? readdirSync(registrations) : []);
  const r = run(dir, `joinPool("gamma", 3, 2); setDemand(0); setDemand(3); mark("joined"); while (!has("stop")) await sleep(25);`);
  await until(() => existsSync(join(dir, "joined")), "the run to join");
  const [file] = readdirSync(registrations).filter((f) => f.endsWith(".run") && !before.has(f));
  const entry = JSON.parse(readFileSync(join(registrations, file), "utf8"));
  assert.equal(entry.project, "gamma");
  assert.equal(entry.concurrency, 3);
  assert.equal(entry.shares, true);
  assert.ok([2, 3].includes(entry.demand));
  writeFileSync(join(dir, "stop"), "");
  await r.done;
  assert.ok(!existsSync(join(registrations, file)), "gone with its process");
});
