// A host test run leaves no temp directory and no fixture process behind. `pnpm test`, `test:shard`,
// `test:weights` and test/run-shards.sh run through test/in-temp.sh, which makes one directory for the whole run,
// exports it as TMPDIR and removes it on the way out - also when killed; a node child started
// through test/cli-spawn.ts dies with the test process, also when that was killed outright.
// No Docker, model calls or network.
//
//   node --test test/temp-cleanup.test.ts

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT, startNode } from "./cli-spawn.ts";

const dir = mkdtempSync(join(tmpdir(), "sandcastle-temp-cleanup-"));
const pids: number[] = [];
after(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const IN_TEMP = join(KIT, "test/in-temp.sh");
/** Running: a zombie (killed, but its parent or init has not reaped it, as in a container with no init) is gone. `ps -o stat=` reads the same on BSD and GNU. */
const alive = (pid: number) => {
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const state = r.stdout.trim();
  return r.status === 0 && state !== "" && !state.startsWith("Z");
};
const until = async (what: string, done: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) assert.fail(`${what} did not happen in ${ms / 1000}s`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
/** A fresh directory standing for the host's TMPDIR. */
const outerTmp = (name: string) => {
  const outer = join(dir, name);
  mkdirSync(outer);
  return outer;
};

// What a test file does: make a `sandcastle-*` directory in os.tmpdir() and never remove it.
const MAKE_DIR = 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "sandcastle-leak-"));';

test("a run leaves no new sandcastle directory in the outer TMPDIR, and its command sees a TMPDIR inside it", () => {
  const outer = outerTmp("clean");
  const r = spawnSync("bash", [IN_TEMP, process.execPath, "-e", `${MAKE_DIR} console.log(require("node:os").tmpdir())`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: outer } });
  assert.equal(r.status, 0, r.stderr);
  const seen = r.stdout.trim();
  assert.ok(seen.startsWith(outer + "/"), `the command's tmpdir ${seen} is inside ${outer}`);
  assert.deepEqual(readdirSync(outer), [], "the outer TMPDIR is as it was");
});

test("a run that fails gives its status and leaves nothing", () => {
  const outer = outerTmp("failed");
  const r = spawnSync("bash", [IN_TEMP, process.execPath, "-e", `${MAKE_DIR} process.exit(3)`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: outer } });
  assert.equal(r.status, 3);
  assert.deepEqual(readdirSync(outer), []);
});

test("a run killed with SIGTERM stops its command and removes the directory at once", async () => {
  const outer = outerTmp("terminated");
  const script = `${MAKE_DIR} console.log("up " + process.pid); setInterval(() => {}, 1000);`;
  const child = spawn("bash", [IN_TEMP, process.execPath, "-e", script], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TMPDIR: outer } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  await until("the command starting", () => /up \d+\n/.test(out));
  const commandPid = Number(/up (\d+)/.exec(out)![1]);
  pids.push(commandPid);
  assert.equal(readdirSync(outer).length, 1, "the run's directory exists while it runs");
  const ended = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  assert.equal(await ended, 143);
  assert.deepEqual(readdirSync(outer), []);
  await until("the command ending", () => !alive(commandPid));
});

test("a run killed with SIGTERM ends its command's descendants too, and removes the directory", async () => {
  const outer = outerTmp("terminated-tree");
  // test/run-shards.sh's shape: a shell that backgrounds its work and waits on it, so the test
  // processes are grandchildren of in-temp.sh; a TERM to the shell alone left them running.
  const script = `${MAKE_DIR} console.log("up " + process.pid); setInterval(() => {}, 1000);`;
  const child = spawn("bash", [IN_TEMP, "bash", "-c", 'echo "shell $$"; "$0" -e "$1" & wait', process.execPath, script], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TMPDIR: outer } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  await until("the command starting", () => /up \d+\n/.test(out));
  const shellPid = Number(/shell (\d+)/.exec(out)![1]);
  const grandchildPid = Number(/up (\d+)/.exec(out)![1]);
  pids.push(shellPid, grandchildPid);
  const ended = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  assert.equal(await ended, 143);
  assert.deepEqual(readdirSync(outer), []);
  // in-temp.sh waits for the group to drain before removing the directory, so nothing is left once it exits.
  assert.equal(alive(shellPid), false, "the shell is gone");
  assert.equal(alive(grandchildPid), false, "the grandchild is gone");
});

test("the test scripts and run-shards.sh run through in-temp.sh", () => {
  const scripts = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).scripts as Record<string, string>;
  for (const name of ["test", "test:shard", "test:file", "test:weights"]) assert.match(scripts[name]!, /^bash test\/in-temp\.sh /, name);
  assert.match(readFileSync(join(KIT, "test/run-shards.sh"), "utf8"), /exec bash .*in-temp\.sh/);
});

/** A test process of its own: a script that has `startNode` in scope and runs `body`. */
const testProcess = (name: string, body: string) => {
  const file = join(dir, `${name}.mts`);
  writeFileSync(file, `import { startNode } from ${JSON.stringify(join(KIT, "test/cli-spawn.ts"))};\n${body}\n`);
  return file;
};
const FIXTURE = join(dir, "fixture.mts");
// It says it is running (its preload has run by then) in the file it is given; and stays up.
writeFileSync(FIXTURE, 'import { writeFileSync } from "node:fs";\nif (process.argv[2]) writeFileSync(process.argv[2], "up");\nsetInterval(() => {}, 1000);\n');

test("a fixture dies when the test process that started it is killed outright", async () => {
  const pidFile = join(dir, "killed-fixture.pid");
  const upFile = join(dir, "killed-fixture.up");
  const parentFile = testProcess("killed-parent", `const f = startNode([${JSON.stringify(FIXTURE)}, ${JSON.stringify(upFile)}], { stdio: "ignore" });\nawait import("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(pidFile)}, String(f.pid)));\nsetInterval(() => {}, 1000);`);
  const parent = startNode([parentFile], { stdio: "ignore" });
  pids.push(parent.pid!);
  // Once the fixture is up: a parent killed before its child's preload ran would leave nothing to watch with.
  await until("the fixture starting", () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "" && existsSync(upFile));
  const fixture = Number(readFileSync(pidFile, "utf8"));
  pids.push(fixture);
  assert.ok(alive(fixture));
  parent.kill("SIGKILL"); // no exit handler runs in the parent
  await until("the fixture ending", () => !alive(fixture));
});

test("a fixture dies when the test process that started it exits", async () => {
  const pidFile = join(dir, "exited-fixture.pid");
  const parentFile = testProcess("exiting-parent", `const f = startNode([${JSON.stringify(FIXTURE)}], { stdio: "ignore" });\nawait import("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(pidFile)}, String(f.pid)));\nprocess.exit(0);`);
  const parent = startNode([parentFile], { stdio: "ignore" });
  await new Promise((resolve) => parent.on("exit", resolve));
  const fixture = Number(readFileSync(pidFile, "utf8"));
  pids.push(fixture);
  await until("the fixture ending", () => !alive(fixture));
});

test("a run a fixture detaches outlives it: only the test process's own children are watched", async () => {
  const pidFile = join(dir, "detached.pid");
  // What `sandcastle run --detach` does: starts the run with the starter's own execArgv, and ends.
  const starter = join(dir, "starter.mts");
  writeFileSync(
    starter,
    `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst c = spawn(process.execPath, [...process.execArgv, ${JSON.stringify(FIXTURE)}], { detached: true, stdio: "ignore" });\nc.unref();\nwriteFileSync(${JSON.stringify(pidFile)}, String(c.pid));\n`,
  );
  const parent = startNode([starter], { stdio: "ignore" });
  await new Promise((resolve) => parent.on("exit", resolve));
  const detached = Number(readFileSync(pidFile, "utf8"));
  pids.push(detached);
  // Several of the watch's own intervals after its starter ended.
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(alive(detached), "the detached run was ended by the watch");
});
