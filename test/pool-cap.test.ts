// A cap (`sandcastle cap`, src/pool.ts) is a person's limit on one live run's share. It lives in the
// run's registration and ends with the run. It only lowers the share (the slots it frees go to the
// other runs, up to their demand), and a capped run above it keeps the slots it holds.
// Runs are child processes that look like the kit to `ps`, as in test/pool-shares.test.ts.
//
//   pnpm exec tsx --test test/pool-cap.test.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";

const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = cache;
process.env.SANDCASTLE_MAX_SANDBOXES = "6";
const { members, parseCapArgs, setCap, slotsByRun, splitShares, standing } = await import("../src/pool.ts");

const tsx = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs");
const pool = join(import.meta.dirname, "../src/pool.ts");
const slots = join(cache, "sandcastle-kit", "slots");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

/** A run: a process whose command line holds the kit's entry, running `body` with the pool's API in scope. */
const run = (dir: string, body: string) => {
  const script =
    `globalThis.entry = ${JSON.stringify(RUN_COMMAND)};` +
    `const { withSlot, joinPool, setDemand } = await import(${JSON.stringify(pool)});` +
    `const fs = await import("node:fs"); const dir = ${JSON.stringify(dir)};` +
    `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));` +
    `const mark = (name) => fs.appendFileSync(dir + "/" + name, "x"); const has = (name) => fs.existsSync(dir + "/" + name);` +
    body;
  const child = spawn(process.execPath, [tsx, "--input-type=module", "-e", script], {
    env: { ...process.env, SANDCASTLE_MAX_SANDBOXES: "6", SANDCASTLE_MAX_GATES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
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
  done.catch(() => {});
  runs.push(kill);
  return { done, kill };
};
const tmp = () => mkdtempSync(join(tmpdir(), "sandcastle-cap-"));
const heldBy = () => [...slotsByRun("sandboxes").values()].sort();
const shareOf = (project: string) => members().find((m) => m.project === project)?.share;
const holds = async (ok: () => boolean, ms = 1000) => {
  for (let t = 0; t < ms; t += 50) {
    assert.ok(ok(), `held ${heldBy()} at ${t} ms: ${JSON.stringify(members())}`);
    await sleep(50);
  }
};
const registered = (...projects: string[]) => () => projects.every((p) => members().some((m) => m.project === p && m.registered));

/** `workers` tickets that each hold a slot until `release<prefix><i>` or `stop` appears. */
const tickets = (project: string, prefix: string, workers: number) =>
  `await Promise.all(Array.from({ length: ${workers} }, (_, i) => withSlot("sandboxes", ${JSON.stringify(project)} + i, async () => { while (!has("stop") && !has("release${prefix}" + i)) await sleep(25); }, undefined, 25)));`;

test("the split: a cap lowers what a run asks for, and the others take the rest up to their demand", () => {
  const split = (total: number, wants: [number, number?][]) => {
    const shares = splitShares(total, wants.map(([demand, cap], i) => ({ run: `r${i}`, demand, cap, since: i })));
    return wants.map((_, i) => shares.get(`r${i}`));
  };
  assert.deepEqual(split(6, [[5], [5]]), [3, 3]);
  assert.deepEqual(split(6, [[5, 1], [5]]), [1, 5]);
  assert.deepEqual(split(6, [[5], [5, 1]]), [5, 1]);
  assert.deepEqual(split(6, [[5, 1], [3]]), [1, 3], "the others stop at their own demand");
  assert.deepEqual(split(6, [[5, 4], [5]]), [3, 3], "a cap above the share changes nothing");
  assert.deepEqual(split(6, [[2, 4], [5]]), [2, 4], "a cap above the demand changes nothing");
  assert.deepEqual(split(6, [[0, 2], [5]]), [0, 5], "a drained run still has no share");
});

test("a cap of 1 on one of two runs gives the other 5, and lifting it returns both to 3 + 3; the capped run keeps its slots", async () => {
  const dir = tmp();
  // A holds 5 alone; B joins; two of A's tickets finish and are not replaced until it is below its share.
  const a = run(
    dir,
    `joinPool("alpha", 5, 5);
     await Promise.all(Array.from({ length: 5 }, async (_, i) => {
       await withSlot("sandboxes", "a" + i, async () => { while (!has("stop") && !has("releasea" + i)) await sleep(25); }, undefined, 25);
       while (!has("stop")) await withSlot("sandboxes", "a" + i + " again", async () => { while (!has("stop")) await sleep(25); }, undefined, 25);
     }));`,
  );
  await until(() => heldBy().join() === "5", "run A to fill its demand alone");
  const b = run(dir, `joinPool("beta", 5, 5); ${tickets("b", "b", 5)}`);
  await until(registered("alpha", "beta"), "both runs to register");
  for (const i of [0, 1]) writeFileSync(join(dir, `releasea${i}`), "");
  await until(() => heldBy().join() === "3,3", "the equal split");
  assert.deepEqual([shareOf("alpha"), shareOf("beta")], [3, 3]);

  // Capped at 1, A is above its share of 1 and holds 3: it keeps them, and B's share is 5.
  setCap("alpha", 1);
  assert.deepEqual([shareOf("alpha"), shareOf("beta")], [1, 5]);
  await holds(() => heldBy().join() === "3,3");

  // A lets go of two; its own waiting tickets do not take them back, B's do.
  for (const i of [2, 3]) writeFileSync(join(dir, `releasea${i}`), "");
  await until(() => heldBy().join() === "1,5", "B to take what the cap frees");
  await holds(() => heldBy().join() === "1,5");

  // Lifted, both are at their equal split again (B keeps what it holds until its tickets finish).
  setCap("alpha", "off");
  assert.deepEqual([shareOf("alpha"), shareOf("beta")], [3, 3]);
  assert.equal(standing("alpha").cap, undefined);
  for (const i of [0, 1]) writeFileSync(join(dir, `releaseb${i}`), "");
  await until(() => heldBy().join() === "3,3", "A to take the slots B let go of");
  writeFileSync(join(dir, "stop"), "");
  await Promise.all([a.done, b.done]);
});

test("a capped run takes no slot above its cap even when no other run wants one, and takes them again once lifted", async () => {
  const dir = tmp();
  const a = run(dir, `joinPool("alpha", 5, 5); while (!has("go")) await sleep(25); ${tickets("a", "a", 5)}`);
  await until(registered("alpha"), "run A to register");
  setCap("alpha", 2);
  writeFileSync(join(dir, "go"), "");
  await until(() => heldBy().join() === "2", "run A to hold its cap");
  await holds(() => heldBy().join() === "2");
  setCap("alpha", "off");
  await until(() => heldBy().join() === "5", "run A to take its demand");
  writeFileSync(join(dir, "stop"), "");
  await a.done;
});

test("a capped run holds no more than its cap when its demand is below it and no other run wants a slot", async () => {
  // The demand is the scheduler's count, told as it changes: a run can ask for a slot above it, and
  // with no other run its share would not stop it. The cap still does.
  const dir = tmp();
  const a = run(dir, `joinPool("alpha", 5, 1); while (!has("go")) await sleep(25); ${tickets("a", "a", 4)}`);
  await until(registered("alpha"), "run A to register");
  setCap("alpha", 2);
  writeFileSync(join(dir, "go"), "");
  await until(() => heldBy().join() === "2", "run A to hold its cap");
  await holds(() => heldBy().join() === "2");
  writeFileSync(join(dir, "stop"), "");
  await a.done;
});

test("the run's own rewrites of its registration keep a cap set from outside", async () => {
  const dir = tmp();
  const a = run(dir, `joinPool("alpha", 5, 5); while (!has("redemand")) await sleep(25); setDemand(3); joinPool("alpha", 5, 4); mark("done"); while (!has("stop")) await sleep(25);`);
  await until(registered("alpha"), "run A to register");
  setCap("alpha", 2);
  writeFileSync(join(dir, "redemand"), "");
  await until(() => existsSync(join(dir, "done")), "run A to rewrite its registration");
  assert.deepEqual([standing("alpha").demand, standing("alpha").cap], [4, 2]);
  writeFileSync(join(dir, "stop"), "");
  await a.done;
});

test("the cap ends with the run: a new run of the same project starts uncapped", async () => {
  const dir = tmp();
  const first = run(dir, `joinPool("alpha", 5, 5); while (!has("stop")) await sleep(25);`);
  await until(registered("alpha"), "the first run to register");
  setCap("alpha", 2);
  assert.equal(standing("alpha").cap, 2);
  writeFileSync(join(dir, "stop"), "");
  await first.done;
  assert.deepEqual(readdirSync(join(slots, "runs")).filter((f) => f.endsWith(".run")), [], "the registration, and the cap in it, went with the run");
  const second = run(dir, `joinPool("alpha", 5, 5); mark("up"); while (!has("stop2")) await sleep(25);`);
  await until(() => existsSync(join(dir, "up")) && registered("alpha")(), "the second run to register");
  assert.equal(standing("alpha").cap, undefined);
  assert.equal(shareOf("alpha"), 5);
  writeFileSync(join(dir, "stop2"), "");
  await second.done;
});

test("refusals: above the run's concurrency, no live run, and what is no cap", async () => {
  assert.throws(() => setCap("alpha", 1), /No live sandcastle run of project "alpha"/);
  assert.throws(() => standing("alpha"), /No live sandcastle run of project "alpha"/);
  const dir = tmp();
  const a = run(dir, `joinPool("alpha", 4, 4); while (!has("stop")) await sleep(25);`);
  await until(registered("alpha"), "run A to register");
  assert.throws(() => setCap("alpha", 5), /above this run's concurrency of 4/);
  assert.equal(standing("alpha").cap, undefined, "a refused cap is not set");
  assert.equal(setCap("alpha", 4).cap, 4, "concurrency itself is allowed");
  writeFileSync(join(dir, "stop"), "");
  await a.done;
  for (const bad of ["0", "-1", "1.5", "two", "", "3x", "OFF"]) assert.throws(() => parseCapArgs([bad]), /expected a whole number of 1 or more, or "off"/, `"${bad}"`);
  assert.throws(() => parseCapArgs(["1", "2"]), /Usage: sandcastle cap/);
  assert.throws(() => parseCapArgs(["--project"]), /needs the project's name/);
  assert.deepEqual(parseCapArgs(["--project", "x", "3"]), { project: "x", cap: 3 });
  assert.deepEqual(parseCapArgs(["off"]), { project: undefined, cap: "off" });
  assert.deepEqual(parseCapArgs([]), { project: undefined });
});

