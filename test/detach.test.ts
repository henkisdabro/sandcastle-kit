// `sandcastle run --detach`, `wait` and `stop`: the run as a process of its own, found through the
// run lock. A fake run script stands in for the run - it takes the lock, prints the status line,
// and ends when told to - so no Docker and no model calls; `wait`, `stop` and the refusals run
// through the real CLI in a throwaway git repo.
//
//   pnpm exec tsx --test test/detach.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { livePid, OUTPUT_LOG, startDetached } from "../src/detach.ts";
import { startKit } from "./cli-spawn.ts";

const KIT = fileURLToPath(new URL("..", import.meta.url));

// The stand-in for the run. Plain JS, so it starts without a loader. It holds the run lock as the
// real run does, records SIGINT, and ends when a `release` file appears (its content is the exit
// code), the way a run's exit handlers do: lock released first, the record written a moment later.
const FAKE_RUN = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const logs = join(process.cwd(), ".sandcastle/logs");
mkdirSync(logs, { recursive: true });
if (process.env.FAKE_EXIT_AT_ONCE) { console.log("Docker is not running"); process.exit(Number(process.env.FAKE_EXIT_AT_ONCE)); }
writeFileSync(join(logs, "run.lock"), process.pid + " token fake\\n");
writeFileSync(join(logs, "run.json"), JSON.stringify({ orchestrator: "demo", pid: process.pid, startedAt: new Date().toISOString() }));
console.log("args: " + process.argv.slice(2).join(" "));
console.log("detached=" + process.env.SANDCASTLE_DETACHED + " detach=" + process.env.SANDCASTLE_DETACH);
if (!process.env.FAKE_NO_STATUS) console.log("Status view: pane p7 (tab t7)");
const end = (code) => {
  rmSync(join(logs, "run.lock"), { force: true });
  setTimeout(() => {
    writeFileSync(join(logs, "run.json"), JSON.stringify({ orchestrator: "demo", pid: process.pid, finishedAt: new Date().toISOString(), exitCode: code }));
    process.exit(code);
  }, 300);
};
process.on("SIGINT", () => { writeFileSync(join(logs, "sigint"), "seen"); end(130); });
setInterval(() => {
  const release = join(process.cwd(), "release");
  if (existsSync(release)) end(Number(readFileSync(release, "utf8")));
}, 50);
`;
const scripts = mkdtempSync(join(tmpdir(), "sandcastle-detach-script-"));
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

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
const project = (extra = "") => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-detach-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "demo", tracker: "files", gates: [{ name: "t", command: "true" }]${extra} };\n`);
  writeFileSync(join(root, ".gitignore"), ".sandcastle/logs/\nrelease\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base");
  return root;
};

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The real CLI, started and left running: `done` resolves with its exit code and output. */
const cli = (root: string, args: string[], env: Record<string, string> = {}) => {
  const child = startKit(args, {
    cwd: root,
    env: { ...process.env, HERDR_ENV: "", SANDCASTLE_DETACH: "", AUTONOMY_LEVEL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on("close", (code) => resolve({ code, out, err })));
  return { child, done, exited: () => child.exitCode !== null || child.signalCode !== null };
};

const begin = async (root: string, args: string[] = [], inHerdr = true) => {
  const r = await startDetached(root, args, { entry: [fake], inHerdr, timeoutMs: 15_000 });
  const pid = livePid(root);
  if (pid) started.push(pid);
  return { ...r, pid };
};

test("--detach returns while the run goes on: its output lands in the log, it holds the lock, it has a session of its own", async () => {
  const root = project();
  const run = await begin(root, ["12", "--dry"]);
  assert.equal(run.code, 0);
  assert.ok(run.pid && alive(run.pid), "the run is still going when the starter returns");
  assert.equal(
    run.lines.join("\n"),
    `Run started detached (pid ${run.pid}). Status view: pane p7 (tab t7). Output: .sandcastle/logs/run-output.log. ` +
      "`sandcastle wait` ends with the run; `sandcastle stop` stops it.",
  );
  const log = readFileSync(join(root, OUTPUT_LOG), "utf8");
  assert.match(log, /^args: run 12 --dry$/m, "the run's arguments, less --detach, follow `run`");
  // The child must not detach again, and says it is detached (it then ignores SIGHUP).
  assert.match(log, /^detached=1 detach=undefined$/m);
  // detached: its own process group, so a signal to the starter's group never reaches it.
  assert.doesNotThrow(() => process.kill(-run.pid!, 0));
  writeFileSync(join(root, "release"), "0");
  await until("the run to end", () => !alive(run.pid!));
});

test("the log is truncated at the start of each run", async () => {
  const root = project();
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, OUTPUT_LOG), "from an earlier run\n");
  const run = await begin(root);
  assert.doesNotMatch(readFileSync(join(root, OUTPUT_LOG), "utf8"), /earlier run/);
  writeFileSync(join(root, "release"), "0");
  await until("the run to end", () => !alive(run.pid!));
});

test("without Herdr the status line says how to watch it, once the run holds the lock", async () => {
  const root = project();
  const run = await begin(root, [], false);
  assert.match(run.lines[0], /^Run started detached \(pid \d+\)\. Status view: run `sandcastle status`\. Output: /);
  writeFileSync(join(root, "release"), "0");
  await until("the run to end", () => !alive(run.pid!));
});

test("a run that ends before it is going is reported with its output, and its exit code", async () => {
  const root = project();
  process.env.FAKE_EXIT_AT_ONCE = "2";
  try {
    const r = await startDetached(root, [], { entry: [fake], inHerdr: true, timeoutMs: 15_000 });
    assert.equal(r.code, 2);
    assert.match(r.lines.join("\n"), /The run ended at once \(exit 2\)[^]*Docker is not running/);
  } finally {
    delete process.env.FAKE_EXIT_AT_ONCE;
  }
});

test("wait blocks while the run lives, then prints the summary and exits with the run's code", async () => {
  const root = project();
  const run = await begin(root);
  const wait = cli(root, ["wait"]);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(wait.exited(), false, "wait returned while the run was live");
  writeFileSync(join(root, "release"), "3");
  const r = await wait.done;
  assert.equal(r.code, 3, r.err);
  // The record's exit code is written after the lock goes: wait must not read it too early.
  assert.match(r.out, /per-ticket record|## Run/);
  assert.ok(!alive(run.pid!));
});

test("wait with a timeout exits 124 and leaves the run alone", async () => {
  const root = project();
  const run = await begin(root);
  const r = await cli(root, ["wait", "1"]).done;
  assert.equal(r.code, 124, r.err);
  assert.match(r.out, new RegExp(`still live \\(pid ${run.pid}\\)`));
  assert.ok(alive(run.pid!), "the run is untouched");
  writeFileSync(join(root, "release"), "0");
  await until("the run to end", () => !alive(run.pid!));
});

test("stop sends the run SIGINT, as Ctrl-C does, and says how to see the end", async () => {
  const root = project();
  const run = await begin(root);
  const r = await cli(root, ["stop"]).done;
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), `Stopping the run (pid ${run.pid}); \`sandcastle wait\` shows how it ended.`);
  await until("the run to see SIGINT", () => existsSync(join(root, ".sandcastle/logs/sigint")));
  await until("the run to end", () => !alive(run.pid!));
  // With nothing live: stop says so, and wait gives the last summary and the recorded code.
  const again = await cli(root, ["stop"]).done;
  assert.equal(again.code, 0);
  assert.equal(again.out.trim(), "No run is live.");
  const last = await cli(root, ["wait"]).done;
  assert.equal(last.code, 130, "the exit code the run recorded");
});

test("wait with no run ever recorded exits 0", async () => {
  const r = await cli(project(), ["wait"]).done;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No run recorded yet/);
});

test("wait refuses an argument that is not a number of seconds", async () => {
  const r = await cli(project(), ["wait", "soon"]).done;
  assert.equal(r.code, 1);
  assert.match(r.err, /Usage: sandcastle wait \[seconds\]/);
});

const LEVEL_1 = "Autonomy level 1 asks a question at the end of each turn, which a detached run cannot. Use level 2 or 3, or run attached.";

test("autonomy level 1 with --detach is refused before anything starts", async () => {
  const root = project();
  for (const [args, env] of [
    [["run", "--detach"], { AUTONOMY_LEVEL: "1" }],
    [["run"], { AUTONOMY_LEVEL: "1", SANDCASTLE_DETACH: "1" }],
  ] as const) {
    const r = await cli(root, [...args], env).done;
    assert.equal(r.code, 1, r.err);
    assert.ok(r.err.includes(LEVEL_1), r.err);
    assert.equal(existsSync(join(root, OUTPUT_LOG)), false, "no process was started");
    assert.equal(existsSync(join(root, ".sandcastle/logs/run.lock")), false);
  }
  // The project's own autonomy setting counts as much as the variable.
  const configured = project(", autonomy: 1");
  const r = await cli(configured, ["run", "--detach"]).done;
  assert.ok(r.err.includes(LEVEL_1), r.err);
  assert.equal(existsSync(join(configured, OUTPUT_LOG)), false);
});

test("--detach refuses a dirty tree and a live run, before starting a process", async () => {
  const root = project();
  writeFileSync(join(root, "stray.txt"), "x\n");
  const dirty = await cli(root, ["run", "--detach"]).done;
  assert.equal(dirty.code, 1);
  assert.match(dirty.err, /NOT STARTED: the working tree is dirty/);
  assert.equal(existsSync(join(root, OUTPUT_LOG)), false);

  const clean = project();
  const run = await begin(clean);
  const busy = await cli(clean, ["run", "--detach"]).done;
  assert.equal(busy.code, 1);
  assert.match(busy.err, new RegExp(`Another sandcastle run of this project is live \\(pid ${run.pid}\\)`));
  assert.doesNotMatch(readFileSync(join(clean, OUTPUT_LOG), "utf8"), /^args: run --detach/m, "no second run started");
  writeFileSync(join(clean, "release"), "0");
  await until("the run to end", () => !alive(run.pid!));
});

test("a detached run ignores SIGHUP; an attached one still ends on it", async () => {
  const probe = join(scripts, "hup.mts");
  writeFileSync(
    probe,
    `import { exitOnSignal } from ${JSON.stringify(join(KIT, "src/run.ts"))};\n` +
      "exitOnSignal();\n" +
      'process.kill(process.pid, "SIGHUP");\n' +
      'setTimeout(() => { console.log("survived"); process.exit(0); }, 300);\n',
  );
  const run = (env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = startKit([], { script: probe, env: { ...process.env, SANDCASTLE_DETACHED: "", ...env }, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout!.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });
  const detached = await run({ SANDCASTLE_DETACHED: "1" });
  assert.equal(detached.code, 0);
  assert.match(detached.out, /survived/);
  const attached = await run({});
  assert.notEqual(attached.code, 0);
  assert.doesNotMatch(attached.out, /survived/);
});
