// `sandcastle gates` and `sandcastle land` open a gate-only sandbox, so the CPU limit they pass to
// `docker run --cpus` is the gate share (the VM's CPUs divided by `maxGates`), cut to the VM's
// CPUs, as a run's landing and base gates get it. Both once passed the project's `cpus` as written:
// 16 on an 8-CPU VM was refused by docker, and with `cpus` unset there was no limit at all.
//
// The kit runs as a child process against a fake `docker` that answers `info` with a made-up VM
// and logs each `run`; no Docker, no model, no network. The fake's `exec` does nothing, so a
// landing ends in a refusal (nothing was merged in its sandbox): the container's start is the
// test, not the landing.
//
//   pnpm test:file test/sandbox-cpus-commands.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-cpus-commands-")));
const bin = join(dir, "bin");
mkdirSync(bin);
// `info` is the VM (NCPU from the test's environment); every other call succeeds and says nothing.
// Each `run` is one line in the log: the container's start is the one that names it.
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh
case "$1" in
  info) echo "{\\"NCPU\\":$FAKE_NCPU,\\"MemTotal\\":17179869184}";;
  run) echo "$@" >> "$FAKE_DOCKER_LOG";;
esac
exit 0
`,
);
chmodSync(join(bin, "docker"), 0o755);
// Made-up credentials: a sandbox's environment needs them, and the fake docker never reads them.
const config = join(dir, "config");
mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
writeFileSync(join(config, "sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");

let n = 0;
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "ignore" });
// A repo with a ticket-file project, one ticket and a branch for it, so `land` gets as far as its sandbox.
const project = (extra: string) => {
  const root = join(dir, `project${n++}`);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  mkdirSync(join(root, ".scratch/demo/issues"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "demo", tracker: "files", setup: [], gates: [{ name: "ok", command: "true" }]${extra} };\n`);
  writeFileSync(join(root, ".scratch/demo/issues/01-thing.md"), "# A thing\n\nStatus: ready-for-agent\n\nDo it.\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "agent/issue-demo-01");
  writeFileSync(join(root, "feature.txt"), "the feature\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  git(root, "checkout", "-q", "main");
  return root;
};

/** The `--cpus` each container the command started was given (`none` for no flag), one per start. */
const started = (root: string, command: string[], ncpu: number, machine?: string) => {
  const log = join(dir, `docker-${n++}.log`);
  writeFileSync(log, "");
  const home = join(dir, `config-${n++}`);
  mkdirSync(join(home, "sandcastle-kit"), { recursive: true });
  writeFileSync(join(home, "sandcastle-kit/.env"), readFileSync(join(config, "sandcastle-kit/.env"), "utf8"));
  if (machine) writeFileSync(join(home, "sandcastle-kit/config.json"), machine);
  const r = runKit(command, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      // The running node before the inherited PATH: with XDG_CONFIG_HOME moved, a version manager's
      // `node` shim there cannot find its config, and the lean-apply host hook fails on a Mac.
      PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: join(dir, "cache"),
      FAKE_NCPU: String(ncpu),
      FAKE_DOCKER_LOG: log,
      // Exact versions: nothing is resolved over the network.
      CLAUDE_CODE_VERSION: "1.0.0",
      CODEX_VERSION: "0.1.0",
      GIT_CEILING_DIRECTORIES: tmpdir(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const runs = readFileSync(log, "utf8").split("\n").filter((l) => l.includes("--name"));
  return { r, cpus: runs.map((l) => l.match(/--cpus (\S+)/)?.[1] ?? "none") };
};

test("sandcastle gates cuts the project's cpus to the VM's CPUs, which docker would otherwise refuse", () => {
  const root = project(", cpus: 16");
  const { r, cpus } = started(root, ["gates"], 8);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(cpus, ["8"]);
});

test("sandcastle gates with no cpus set gives its sandbox the gate share: the VM's CPUs divided by maxGates", () => {
  // 12 CPUs, the default of 2 gates at a time.
  const { r, cpus } = started(project(""), ["gates"], 12);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(cpus, ["6"]);
});

test("sandcastle gates divides by the maxGates of the machine settings", () => {
  const { r, cpus } = started(project(""), ["gates"], 12, '{"maxGates": 3}');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(cpus, ["4"]);
});

test("sandcastle gates with cpus: false sets no limit", () => {
  const { r, cpus } = started(project(", cpus: false"), ["gates"], 12);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(cpus, ["none"]);
});

test("sandcastle land cuts the project's cpus to the VM's CPUs, which docker would otherwise refuse", () => {
  const { cpus } = started(project(", cpus: 16"), ["land", "demo-01"], 8);
  assert.deepEqual(cpus, ["8"]);
});

test("sandcastle land with no cpus set gives its sandbox the gate share", () => {
  const { cpus } = started(project(""), ["land", "demo-01"], 12);
  assert.deepEqual(cpus, ["6"]);
});
