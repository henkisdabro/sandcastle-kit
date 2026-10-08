// `sandcastle wait` started inside the gap between a run's two exit handlers: the run lock is
// already released, the record has no `exitCode` yet, and the process is still alive. A real run
// has that gap for a moment; the fake one here holds it open until told to go on, so the test
// waits on files, not on a clock. Wait must keep waiting for the live pid in run.json and then
// exit with the recorded code, not 0.
//
//   pnpm test:file test/detach-gap.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { startKit } from "./cli-spawn.ts";


// Plain JS stand-in for a run. It takes the lock and writes its record; when `release` appears it
// drops the lock, then holds the gap open until `record` appears, writes the exit code and ends.
const FAKE_RUN = `
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
const logs = join(root, ".sandcastle/logs");
mkdirSync(logs, { recursive: true });
writeFileSync(join(logs, "run.lock"), process.pid + " token fake\\n");
writeFileSync(join(logs, "run.json"), JSON.stringify({ orchestrator: "demo", pid: process.pid, startedAt: new Date().toISOString() }));
let released = false;
setInterval(() => {
  if (!released && existsSync(join(root, "release"))) {
    released = true;
    rmSync(join(logs, "run.lock"), { force: true });
    writeFileSync(join(root, "gap"), "open");
  }
  if (released && existsSync(join(root, "record"))) {
    writeFileSync(join(logs, "run.json"), JSON.stringify({ orchestrator: "demo", pid: process.pid, finishedAt: new Date().toISOString(), exitCode: 4 }));
    process.exit(4);
  }
}, 20);
`;
const scripts = mkdtempSync(join(tmpdir(), "sandcastle-detach-gap-script-"));
// Under a directory named for the kit's entry, so its command line reads as the kit's (src/live-runs.ts
// `commandOf`): a run is a process whose command line holds it, and this stand-in has to pass for one.
const fake = join(scripts, "src/cli.ts/fake-run.mjs");
mkdirSync(dirname(fake), { recursive: true });
writeFileSync(fake, FAKE_RUN);

const started: number[] = [];
after(() => {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-detach-gap-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "demo", tracker: "files", gates: [{ name: "t", command: "true" }] };\n`);
  writeFileSync(join(root, ".gitignore"), ".sandcastle/logs/\nrelease\nrecord\ngap\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
};

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("wait started in the gap (lock gone, no exitCode, pid alive) waits for the record's exit code", async () => {
  const root = project();
  const run = spawn(process.execPath, [fake], { cwd: root, stdio: "ignore" });
  const ended = new Promise<void>((resolve) => run.on("exit", () => resolve()));
  started.push(run.pid!);
  await until("the run to take its lock", () => existsSync(join(root, ".sandcastle/logs/run.lock")));
  writeFileSync(join(root, "release"), "");
  await until("the gap to open", () => existsSync(join(root, "gap")));
  assert.equal(existsSync(join(root, ".sandcastle/logs/run.lock")), false, "the lock is already released");

  const child = startKit(["wait"], {
    cwd: root,
    env: { ...process.env, HERDR_ENV: "", SANDCASTLE_DETACH: "", AUTONOMY_LEVEL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  let early = false;
  child.on("exit", () => (early = true));
  // Long enough for node and loadProject to finish and wait to poll; a wait that returns here read no code.
  await Promise.race([done, new Promise((r) => setTimeout(r, 4000))]);
  assert.equal(early, false, "wait returned while the run was still alive in the gap");

  writeFileSync(join(root, "record"), "");
  assert.equal(await done, 4, err);
  await ended;
  rmSync(root, { recursive: true, force: true });
});
