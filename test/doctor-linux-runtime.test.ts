// The setups a run cannot work on, said by doctor and refused by `sandcastle run`: the kit as root
// (Claude Code refuses to skip permissions as root), and on Linux Podman behind `docker` or rootless
// Docker (the agent's uid maps to a subuid and cannot write the bind-mounted worktree). Doctor used
// to call `podman-docker` "not running" and pass rootless Docker. The shims print the outputs
// captured from each runtime. No Docker, no network.
//
//   pnpm exec tsx --test test/doctor-linux-runtime.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const tmp = mkdtempSync(join(tmpdir(), "sc-runtime-"));
process.env.XDG_CONFIG_HOME = join(tmp, "config");
const { runtimeProblem } = await import("../src/runtime.ts");

type Shape = { version: string; info: number; security?: string; server: string };

const ROOTFUL_SERVER = '{"Platform":{"Name":"Docker Engine - Community"},"Components":[{"Name":"Engine"},{"Name":"containerd"},{"Name":"runc"},{"Name":"docker-init"}],"Version":"29.4.0"}';
const PODMAN_SERVER = '{"Platform":{"Name":"linux/arm64/fedora-44"},"Components":[{"Name":"Podman Engine"},{"Name":"Conmon"},{"Name":"OCI Runtime (crun)"},{"Name":"Engine"}],"Version":"5.8.7"}';

const SHAPES: Record<string, Shape> = {
  rootful: { version: "Docker version 29.4.0, build 9d7ad9f", info: 0, security: '["name=seccomp,profile=builtin","name=cgroupns"]', server: ROOTFUL_SERVER },
  rootless: {
    version: "Docker version 29.8.2, build 1a2b3c4",
    info: 0,
    security: '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]',
    server: '{"Platform":{"Name":"Docker Engine - Community"},"Components":[{"Name":"Engine"},{"Name":"containerd"},{"Name":"runc"},{"Name":"docker-init"},{"Name":"rootlesskit"},{"Name":"slirp4netns"}],"Version":"29.8.2"}',
  },
  // The `podman-docker` script: every `--format` field of `docker info` exits 125, `.Server` is null.
  podmanDocker: { version: "podman version 5.8.7", info: 0, server: "null" },
  compatRootful: { version: "Docker version 29.4.0, build 9d7ad9f", info: 0, security: '["name=seccomp,profile=default"]', server: PODMAN_SERVER },
  compatRootless: { version: "Docker version 29.4.0, build 9d7ad9f", info: 0, security: '["name=seccomp,profile=default","name=rootless"]', server: PODMAN_SERVER },
};

// `security` is the shape's SecurityOptions array as `docker info --format '{{json .}}'` prints it among the rest of the daemon's fields.
const infoOf = (s: Shape) => (s.security === undefined ? undefined : `{"NCPU":4,"SecurityOptions":${s.security}}`);
const reads = (s: Shape) => ({ version: () => s.version, server: () => s.server, info: () => infoOf(s) });
const problem = (platform: NodeJS.Platform, uid: number, shape: Shape) => runtimeProblem({ platform, uid, reads: reads(shape) });

test("on Linux, rootful Docker Engine as a normal user has no problem", () => {
  assert.equal(problem("linux", 1000, SHAPES.rootful), undefined);
});

test("on Linux, rootless Docker is refused as not supported yet, naming the parked ticket", () => {
  const p = problem("linux", 1000, SHAPES.rootless);
  assert.equal(p?.label, "rootful Docker Engine (found rootless Docker)");
  assert.match(p!.fix, /Rootless Docker is not supported yet \(#359\).*cannot write the bind-mounted worktree.*docker context use default/);
});

test("on Linux, Docker with userns-remap is refused like rootless Docker", () => {
  const p = problem("linux", 1000, { ...SHAPES.rootful, security: '["name=seccomp,profile=builtin","name=userns"]' });
  assert.equal(p?.label, "rootful Docker Engine (found Docker with userns-remap)");
  assert.match(p!.fix, /not supported yet \(#359\)/);
});

test("on Linux, Podman behind docker is named as Podman in every shape", () => {
  for (const shape of [SHAPES.podmanDocker, SHAPES.compatRootful, SHAPES.compatRootless]) {
    const p = problem("linux", 1000, shape);
    assert.equal(p?.label, "Docker Engine behind `docker` (found Podman)");
    assert.match(p!.fix, /^Podman behind `docker` is not supported on Linux yet \(#359\).*rootful Docker Engine.*docker context ls.*DOCKER_HOST/);
  }
});

test("on macOS, Podman and rootless-looking options are no problem", () => {
  for (const shape of Object.values(SHAPES)) assert.equal(problem("darwin", 501, shape), undefined);
});

test("root is refused on every platform, whatever the runtime", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const p = problem(platform, 0, SHAPES.rootful);
    assert.equal(p?.label, "sandcastle run as a normal user, not root");
    assert.match(p!.fix, /not as root or with sudo.*refuses `--dangerously-skip-permissions` as root/);
  }
  assert.match(problem("linux", 0, SHAPES.rootful)!.fix, /sudo usermod -aG docker \$USER/);
});

test("a runtime printing something unexpected is no crash", () => {
  assert.equal(problem("linux", 1000, { version: "", info: 0, security: "not json", server: "{oops" }), undefined);
  assert.equal(runtimeProblem({ platform: "linux", uid: undefined, reads: { version: () => undefined, server: () => undefined, info: () => undefined } }), undefined);
});

// A `docker` that prints a shape's captured output and logs each call; anything else fails, as
// a runtime missing a field does.
const shim = (shape: Shape) => {
  const bin = mkdtempSync(join(tmp, "bin-"));
  const log = join(bin, "calls.log");
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${q(log)}`,
      'case "$*" in',
      `  --version) echo ${q(shape.version)} ;;`,
      `  info) echo "Client: x"; exit ${shape.info} ;;`,
      shape.security === undefined ? "" : `  "info --format {{json .}}") echo ${q(infoOf(shape)!)} ;;`,
      `  "version --format {{json .Server}}") echo ${q(shape.server)} ;;`,
      "  *) echo \"Error: can't evaluate field\" >&2; exit 125 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  for (const [name, body] of [["docker", ""], ["gh", "#!/bin/sh\nexit 0\n"], ["jq", "#!/bin/sh\nexit 0\n"]]) {
    if (body) writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const gitconfig = join(tmp, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = T\n\temail = t@example.com\n");
  mkdirSync(join(tmp, "config/sandcastle-kit"), { recursive: true });
  const env = {
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: tmp,
    XDG_CONFIG_HOME: join(tmp, "config"),
    XDG_CACHE_HOME: join(tmp, "cache"),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: tmp,
  };
  return { env, log };
};

const doctor = (shape: Shape) => {
  const { env } = shim(shape);
  const r = runKit(["doctor"], { cwd: tmp, env, encoding: "utf8" });
  return r.stdout + r.stderr;
};

const linux = process.platform === "linux";
// A root test run would print the root line before any runtime line.
const normalUser = process.getuid?.() !== 0;

test("doctor on Linux: podman-docker is running, and refused as Podman", { skip: !linux || !normalUser }, () => {
  const out = doctor(SHAPES.podmanDocker);
  assert.match(out, /^ok   Docker running$/m);
  assert.doesNotMatch(out, /^FIX  Docker running/m);
  assert.match(out, /^FIX  Docker Engine behind `docker` \(found Podman\)\n +-> Podman behind `docker` is not supported on Linux yet \(#359\)/m);
});

test("doctor on Linux: rootless Docker gets the rootless FIX", { skip: !linux || !normalUser }, () => {
  const out = doctor(SHAPES.rootless);
  assert.match(out, /^ok   Docker running$/m);
  assert.match(out, /^FIX  rootful Docker Engine \(found rootless Docker\)\n +-> Rootless Docker is not supported yet \(#359\)/m);
});

test("doctor on Linux: rootful Docker passes with neither line", { skip: !linux || !normalUser }, () => {
  const out = doctor(SHAPES.rootful);
  assert.match(out, /^ok   Docker running$/m);
  assert.doesNotMatch(out, /found Podman|found rootless|not root/);
});

test("doctor on macOS: the same shims give neither line", { skip: process.platform !== "darwin" || !normalUser }, () => {
  for (const shape of [SHAPES.podmanDocker, SHAPES.rootless, SHAPES.compatRootless]) {
    const out = doctor(shape);
    assert.match(out, /^ok   Docker running$/m);
    assert.doesNotMatch(out, /found Podman|found rootless/);
  }
});

test("sandcastle run on Linux with rootless Docker exits 1 with doctor's words, before any image or preflight", { skip: !linux || !normalUser }, () => {
  const { env, log } = shim(SHAPES.rootless);
  const repo = join(tmp, "project");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  const r = runKit(["run"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /rootful Docker Engine \(found rootless Docker\): Rootless Docker is not supported yet \(#359\)/);
  // The only docker calls were the runtime reads, `info` among them once: no build, image or run.
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  assert.deepEqual(calls.filter((c) => !["--version", "version --format {{json .Server}}", "info --format {{json .}}"].includes(c)), []);
  assert.equal(existsSync(join(repo, ".sandcastle/logs")), false);
});
