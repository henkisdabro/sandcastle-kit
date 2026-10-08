// A test that starts the kit as a child process goes through test/cli-spawn.ts: it passes the
// launcher's V8 flags (Node 24 can deadlock in `process.exit` without them, nodejs/node#66171) and
// a time limit, so a stuck child fails the test with its command named instead of hanging
// `pnpm test`, every gate run in a sandbox and `full-check.sh`. No Docker, model calls or network.
//
//   pnpm test:file test/cli-spawn.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLI, flagsOf, KIT, kitArgs, launcherLines, NODE_FLAGS, runKit, runNode, startNode } from "./cli-spawn.ts";

const dir = mkdtempSync(join(tmpdir(), "sandcastle-cli-spawn-"));

test("the helper's flags are the launcher's, on both of its exec lines", () => {
  assert.deepEqual(NODE_FLAGS, ["--no-maglev", "--no-concurrent-sparkplug"]);
  for (const line of launcherLines) assert.deepEqual(flagsOf(line), NODE_FLAGS);
  assert.deepEqual(kitArgs("a.ts", "x").slice(0, NODE_FLAGS.length), NODE_FLAGS);
});

test("a child started through the helper runs with the flags and the kit's loader", () => {
  const r = runNode(["-p", "JSON.stringify(process.execArgv)"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).slice(0, NODE_FLAGS.length), NODE_FLAGS);
  const cli = runKit(["help"], { encoding: "utf8", cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(CLI.endsWith("src/cli.ts"));
});

test("a child that does not end is killed and the test fails naming it", () => {
  const stuck = join(dir, "stuck.mts");
  // A SIGTERM handler that ignores the signal: the helper's kill must not be one a child can refuse.
  writeFileSync(stuck, 'process.on("SIGTERM", () => {});\nconsole.log("up");\nsetInterval(() => {}, 1000);\n');
  const started = Date.now();
  assert.throws(() => runKit(["--flag"], { encoding: "utf8", script: stuck, timeoutMs: 1500 }), /node stuck\.mts --flag did not end in 1\.5s/);
  assert.ok(Date.now() - started < 30_000, "returned long after the limit");
});

test("a started child that does not end is killed after its limit", async () => {
  const stuck = join(dir, "stuck-started.mts");
  writeFileSync(stuck, 'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n');
  // The helper names the command it kills on stderr; hold that line rather than print it into the gate log.
  const write = process.stderr.write;
  const said: string[] = [];
  process.stderr.write = ((chunk: string) => said.push(chunk) > 0) as typeof process.stderr.write;
  let ended: NodeJS.Signals | null;
  try {
    const child = startNode([stuck], { stdio: "ignore", timeoutMs: 1500 });
    ended = await new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
  } finally {
    process.stderr.write = write;
  }
  assert.equal(ended, "SIGKILL");
  assert.match(said.join(""), /node stuck-started\.mts did not end in 1\.5s; killed/);
});

// The launcher's preload named in a test file is a spawn of the kit without the flags and the limit.
// test/mod.test.ts and test/run-live.test.ts only quote the launcher's command line.
const ENTRIES = [["node-check", "mjs"].join(".")];
const QUOTING = new Set(["cli-spawn.ts", "cli-spawn.test.ts", "mod.test.ts", "run-live.test.ts"]);

test("no test file starts the kit with the launcher's preload of its own", () => {
  const offenders = readdirSync(join(KIT, "test"))
    .filter((f) => /\.(ts|sh)$/.test(f) && !QUOTING.has(f))
    .filter((f) => ENTRIES.some((e) => readFileSync(join(KIT, "test", f), "utf8").includes(e)));
  assert.deepEqual(offenders, [], "start the kit with runKit, runNode, startKit or startNode from test/cli-spawn.ts");
});
