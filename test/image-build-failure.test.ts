// A project layer that fails to build is a one-line refusal naming the file to fix, under docker's
// own output - not a stack trace that buries it. And a .sandcastle/Dockerfile the config does not
// name is said to be unbuilt, not silently skipped. A fake docker; no network or model calls.
//
//   pnpm exec tsx --test test/image-build-failure.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const kit = fileURLToPath(new URL("..", import.meta.url));

// The base image exists; anything else does not, and every build fails as docker reports it.
const DOCKER = `#!/bin/sh
case "$1" in
  image) case "$3" in sandcastle-base:*) exit 0;; esac; [ "$2" = ls ] && exit 0; exit 1;;
  build) cat >/dev/null; echo 'ERROR: failed to solve: process "/bin/sh -c false" did not complete successfully: exit code: 1' >&2; exit 1;;
esac
exit 0
`;

const project = (config: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-build-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", setup: [], gates: [{ name: "ok", command: "true" }]${config} };\n`);
  writeFileSync(join(root, ".sandcastle/Dockerfile"), "ARG BASE=sandcastle-base:latest\nFROM ${BASE}\nRUN false\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  return { root, bin };
};

const build = (p: { root: string; bin: string }) =>
  spawnSync(process.execPath, [join(kit, "node_modules/tsx/dist/cli.mjs"), join(kit, "src/cli.ts"), "build"], {
    cwd: p.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Exact versions: nothing is resolved over the network.
    env: { ...process.env, PATH: `${p.bin}${delimiter}${process.env.PATH}`, CLAUDE_CODE_VERSION: "1.0.0", CODEX_VERSION: "0.1.0", GIT_CEILING_DIRECTORIES: tmpdir() },
  });

test("a failing project layer names the Dockerfile to fix, with no stack trace", () => {
  const r = build(project(', dockerfile: ".sandcastle/Dockerfile"'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /failed to solve/);
  assert.match(r.stderr, /Building sandcastle-t:\w+ failed \(docker build exited 1\) - .*Fix \.sandcastle\/Dockerfile, then `sandcastle build` again\./);
  assert.ok(!r.stderr.split("\n").some((l) => /^\s+at /.test(l)), `stack trace in:\n${r.stderr}`);
});

test("a .sandcastle/Dockerfile the config does not name is reported as not built", () => {
  const r = build(project(""));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Not built: \.sandcastle\/Dockerfile - the config names no `dockerfile`\. Add `dockerfile: "\.sandcastle\/Dockerfile"`/);
});
