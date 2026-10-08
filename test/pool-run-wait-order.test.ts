// Within one run a freed sandbox slot goes to the run's longest waiter (src/pool.ts), not to
// whichever worker happens to poll at the moment it frees. The run is a child process that looks
// like the kit to `ps`, as in test/pool-wait-order.test.ts.
//
//   pnpm test:file test/pool-run-wait-order.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUN_COMMAND } from "../mod/hooks/run-live.ts";
import { startNode } from "./cli-spawn.ts";

const cache = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const pool = join(import.meta.dirname, "../src/pool.ts");

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
    timeoutMs: 240_000,
    env: { ...process.env, XDG_CACHE_HOME: cache, SANDCASTLE_MAX_SANDBOXES: "1", SANDCASTLE_MAX_GATES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return new Promise<void>((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(out)))));
};
const logOf = (dir: string) => readFileSync(join(dir, "log"), "utf8").trim().split("\n");

test("two waiters of one run: the earlier one gets the next freed sandbox slot, however often the later one looks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
  // The earlier waiter looks every 400 ms, the later one every 20 ms: only the order, not the timing, can give the slot to the earlier.
  await run(
    dir,
    `let both;
     await withSlot("sandboxes", "holder", async () => {
       const first = withSlot("sandboxes", "first", async () => log("first"), () => mark("first-waits"), 400);
       while (!has("first-waits")) await sleep(5);
       const second = withSlot("sandboxes", "second", async () => log("second"), () => mark("second-waits"), 20);
       while (!has("second-waits")) await sleep(5);
       await sleep(150);
       both = Promise.all([first, second]);
     });
     await both;`,
  );
  assert.deepEqual(logOf(dir), ["first", "second"]);
});

test("a landing's priority wait still goes before an earlier ordinary wait of its run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-wait-"));
  await run(
    dir,
    `let both;
     await withSlot("sandboxes", "holder", async () => {
       const early = withSlot("sandboxes", "early", async () => log("early"), () => mark("early-waits"), 20);
       while (!has("early-waits")) await sleep(5);
       const landing = withSlot("sandboxes", "landing", async () => log("landing"), () => mark("landing-waits"), 400, true);
       while (!has("landing-waits")) await sleep(5);
       await sleep(150);
       both = Promise.all([early, landing]);
     });
     await both;`,
  );
  assert.deepEqual(logOf(dir), ["landing", "early"]);
});
