// A run's start asks the Docker daemon once, and does not wait on one that never answers. The runtime
// check, the sandbox CPU limit and the pool warning used to read `docker` on their own (up to five
// reads of 30 s each, again in the detached child), so a hung daemon stalled a Linux start for minutes
// with no message, and an unanswered read counted as "no problem". Now `docker info` is read once per
// start with a 10 s limit, its answer is shared, and no answer stops the run naming docker. A fake
// `docker` on PATH logs each call and answers (or sleeps); no Docker, no model call, no network.
//
//   pnpm exec tsx --test test/runtime-probe.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sc-probe-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
process.env.XDG_CONFIG_HOME = join(TMP, "xdg-in-process");
const { runtimeProblem, DOCKER_INFO_ENV } = await import("../src/runtime.ts");
const { startDetached } = await import("../src/detach.ts");

const linux = process.platform === "linux";
// A root test run would meet the root refusal before any docker call.
const normalUser = process.getuid?.() !== 0;

// What `docker info --format '{{json .}}'` prints on rootful Docker Engine, cut to the fields the kit reads.
const ROOTFUL = '{"NCPU":12,"MemTotal":34359738368,"OperatingSystem":"Ubuntu 24.04","SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"]}';
const ROOTLESS = '{"NCPU":12,"MemTotal":34359738368,"OperatingSystem":"Ubuntu 24.04","SecurityOptions":["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]}';
const SERVER = '{"Platform":{"Name":"Docker Engine - Community"},"Components":[{"Name":"Engine"},{"Name":"containerd"}],"Version":"29.4.0"}';

let n = 0;
/**
 * A committed project whose queue holds one ticket, so a run that gets past its checks reaches the
 * start lines, and a `docker` that logs every call to `calls` and answers like rootful Docker (or, as
 * `hang`, sleeps on `info`). Anything else it is asked fails, as an unknown subcommand does.
 */
const setup = ({ info = ROOTFUL, hang = false }: { info?: string; hang?: boolean } = {}) => {
  const dir = join(TMP, `case-${n++}`);
  const bin = join(dir, "bin");
  const repo = join(dir, "project");
  const calls = join(dir, "calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, "xdg/sandcastle-kit"), { recursive: true });
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${q(calls)}`,
      'case "$*" in',
      // exec: SIGTERM at the kit's time limit ends the sleep itself, not only the shell around it.
      hang ? '  info*) exec sleep 60 ;;' : `  "info --format {{json .}}") echo ${q(info)} ;;`,
      "  --version) echo 'Docker version 29.4.0, build 9d7ad9f' ;;",
      `  "version --format {{json .Server}}") echo ${q(SERVER)} ;;`,
      "  ps*) ;;",
      "  *) echo \"docker: unknown command\" >&2; exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "docker"), 0o755);
  for (const name of ["gh", "jq"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  mkdirSync(join(repo, ".sandcastle"), { recursive: true });
  mkdirSync(join(repo, ".scratch/demo/issues"), { recursive: true });
  writeFileSync(join(repo, ".sandcastle/config.ts"), 'export default { name: "demo", tracker: "files", gates: [{ name: "t", command: "true" }] };\n');
  writeFileSync(join(repo, ".scratch/demo/issues/01-first.md"), "# First ticket\n\nStatus: ready-for-agent\n\nDo the first thing.\n");
  writeFileSync(join(repo, ".gitignore"), ".sandcastle/logs/\n.sandcastle/.env\n.sandcastle/.run/\n.sandcastle/worktrees/\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const env = {
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "xdg"),
    XDG_CACHE_HOME: join(dir, "cache"),
    GIT_CEILING_DIRECTORIES: tmpdir(),
    // Versions given, so the run asks the release channel nothing.
    CLAUDE_CODE_VERSION: "2.1.285",
    CODEX_VERSION: "0.159.2",
  } as Record<string, string>;
  const logged = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
  return { repo, env, logged };
};

test("on Linux, a docker that does not answer stops the run within about 12 s, naming docker, after one probe", { skip: !linux || !normalUser }, () => {
  const c = setup({ hang: true });
  const started = Date.now();
  const r = runKit(["run"], { cwd: c.repo, env: c.env, encoding: "utf8", timeoutMs: 30_000 });
  const took = (Date.now() - started) / 1000;
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /docker did not answer within 10 s - is the runtime running\?/);
  // 10 s for the one read plus the kit's own start; the old reads (30 s each, six of them) took minutes.
  assert.ok(took < 20, `took ${took} s`);
  assert.deepEqual(c.logged(), ["info --format {{json .}}"], "no probe after the one that got no answer");
  assert.equal(existsSync(join(c.repo, ".sandcastle/logs")), false, "nothing of the run was started");
});

test("on Linux, a run's start reads docker info once and the CPU limit comes from that reading", { skip: !linux || !normalUser }, () => {
  const c = setup();
  const r = runKit(["run", "--dry"], { cwd: c.repo, env: c.env, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  // The run got to its start lines, and its CPU limits are what the one reading gave: 12 CPUs shared by the default concurrency of 4, and by the default 2 gates.
  assert.match(out, /^Sandbox CPUs: 3 each, 6 for landing and base gates$/m, out);
  const calls = c.logged();
  assert.equal(calls.filter((l) => l.startsWith("info")).length, 1, calls.join("\n"));
  assert.equal(calls.filter((l) => l.startsWith("info --format {{json .SecurityOptions}}")).length, 0, "the security options come from the same reading");
});

test("the detached child takes its parent's reading: no second info, and the check the parent made is not repeated", { skip: !linux || !normalUser }, () => {
  const c = setup();
  // What startDetached hands a child: SANDCASTLE_DETACHED and the parent's reading, here a rootless
  // daemon's - a repeated check would refuse it, and a second read would show in the calls.
  const r = runKit(["run", "--dry"], { cwd: c.repo, env: { ...c.env, SANDCASTLE_DETACHED: "1", [DOCKER_INFO_ENV]: ROOTLESS }, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /rootless Docker/, out);
  assert.match(out, /^Sandbox CPUs: 3 each, 6 for landing and base gates$/m, out);
  assert.deepEqual(c.logged().filter((l) => l.startsWith("info") || l === "--version" || l.startsWith("version")), [], "the child asked the daemon nothing of what its parent had");
});

test("a start that was not handed a reading ignores the variable the child is handed one in", { skip: !linux || !normalUser }, () => {
  const c = setup();
  // Set in a person's shell, not by a parent run: the check runs, on what docker says.
  const r = runKit(["run", "--dry"], { cwd: c.repo, env: { ...c.env, [DOCKER_INFO_ENV]: ROOTLESS }, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /rootless Docker/, out);
  assert.equal(c.logged().filter((l) => l.startsWith("info")).length, 1);
});

test("a detached start hands the child the parent's reading, and only that", async () => {
  const dir = mkdtempSync(join(TMP, "detach-"));
  const out = join(dir, "env.json");
  const standIn = join(dir, "child.mjs");
  writeFileSync(standIn, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ info: process.env[${JSON.stringify(DOCKER_INFO_ENV)}] ?? null, detached: process.env.SANDCASTLE_DETACHED }));\n`);
  const seen = async (dockerInfo: string | undefined, inherited?: string) => {
    if (inherited === undefined) delete process.env[DOCKER_INFO_ENV];
    else process.env[DOCKER_INFO_ENV] = inherited;
    rmSync(out, { force: true });
    await startDetached(dir, [], { entry: [standIn], inHerdr: false, timeoutMs: 20_000, dockerInfo });
    return JSON.parse(readFileSync(out, "utf8")) as { info: string | null; detached: string };
  };
  try {
    assert.deepEqual(await seen(ROOTFUL), { info: ROOTFUL, detached: "1" });
    // A parent that read nothing (macOS asks in burndown) passes nothing on, whatever its own environment holds.
    assert.deepEqual(await seen(undefined, ROOTLESS), { info: null, detached: "1" });
  } finally {
    delete process.env[DOCKER_INFO_ENV];
  }
});

test("macOS makes no docker read for the runtime check; Linux reads info before anything else", () => {
  const asked: string[] = [];
  const reads = { version: () => (asked.push("version"), "Docker version 29.4.0"), server: () => (asked.push("server"), SERVER), info: () => (asked.push("info"), ROOTFUL) };
  assert.equal(runtimeProblem({ platform: "darwin", uid: 501, reads }), undefined);
  assert.deepEqual(asked, [], "the check on macOS asks nothing: its one read is burndown's, for the CPU limit");
  assert.equal(runtimeProblem({ platform: "linux", uid: 1000, reads }), undefined);
  assert.deepEqual(asked, ["info", "version", "server"], "info first, so a hung daemon is the one read that waits");
  asked.length = 0;
  assert.equal(runtimeProblem({ platform: "linux", uid: 0, reads })?.label, "sandcastle run as a normal user, not root");
  assert.deepEqual(asked, [], "root is refused before the daemon is asked");
});

// A runtime that starts on demand can take longer than the limit on a cold start: outside Linux the
// turn goes on with no CPU limit instead of stopping, as it did before the limit existed (#380 promised
// macOS no change). On Linux, and for any other failure, the error still stops the run.
test("a silent docker stops a turn on Linux only; elsewhere the turn goes on without its answer", async () => {
  const { turnDockerInfo } = await import("../src/runtime.ts");
  const { OperatorError } = await import("../src/errors.ts");
  const silent = () => {
    throw new OperatorError("docker did not answer within 10 s - is the runtime running?");
  };
  assert.throws(() => turnDockerInfo(silent, "linux"), /did not answer/);
  assert.equal(turnDockerInfo(silent, "darwin"), undefined);
  assert.equal(turnDockerInfo(() => ROOTFUL, "darwin"), ROOTFUL);
  assert.throws(() => turnDockerInfo(() => { throw new Error("a bug"); }, "darwin"), /a bug/);
});
