// What `sandcastle build` prints: a build in which every step was cached prints one line, the re-tag;
// a real build or a failure prints the `Building` line and docker's output. The start line once went
// out before the build watcher knew whether there was real work, so a cached build printed two. A
// real `sandcastle build` against a fake docker that prints BuildKit's plain progress; no Docker.
//
//   pnpm exec tsx --test test/build-output.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

// No image exists until a build makes one (a file under $FAKE_DOCKER_STATE). `build` prints what
// FAKE_BUILD says: `cached` (every step cached), `real` (a RUN step ran) or `fail` (it failed, exit 1).
const DOCKER = `#!/bin/sh
img="$FAKE_DOCKER_STATE"
name() { echo "$1" | tr ':/' '__'; }
case "$1" in
  image)
    case "$2" in
      inspect) [ -e "$img/$(name "$3")" ]; exit $?;;
      *) exit 0;;
    esac;;
  build)
    cat >/dev/null
    shift
    while [ "$1" != "-t" ]; do shift; done
    tag="$2"
    echo '#0 building with "default" instance using docker driver' >&2
    echo '#1 [base 1/2] FROM docker.io/library/debian:12' >&2
    echo '#1 DONE 0.0s' >&2
    echo '#2 [base 2/2] RUN apt-get update' >&2
    case "$FAKE_BUILD" in
      cached) echo '#2 CACHED' >&2;;
      *) echo '#2 0.412 Get:1 http://deb.debian.org bookworm InRelease' >&2
         if [ "$FAKE_BUILD" = fail ]; then echo '#2 ERROR: process "/bin/sh -c apt-get update" did not complete successfully: exit code: 100' >&2; exit 1; fi
         echo '#2 DONE 3.2s' >&2;;
    esac
    echo '#3 exporting to image' >&2
    echo '#3 DONE 0.0s' >&2
    : > "$img/$(name "$tag")"
    exit 0;;
esac
exit 0
`;

const build = (how: "cached" | "real" | "fail") => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-build-output-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  mkdirSync(join(dir, "state"));
  const root = join(dir, "project");
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "one", setup: [], gates: [{ name: "ok", command: "true" }] };\n`);
  return runKit(["build"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_STATE: join(dir, "state"),
      FAKE_BUILD: how,
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_CONFIG_HOME: join(dir, "config"),
      // Exact versions: nothing is resolved over the network.
      CLAUDE_CODE_VERSION: "1.0.0",
      CODEX_VERSION: "0.1.0",
      GIT_CEILING_DIRECTORIES: tmpdir(),
    },
  });
};

test("a fully cached build prints only the re-tagged line, no Building line", () => {
  const r = build("cached");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Image sandcastle-base:\w+ re-tagged from cache$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /Building /);
});

test("a real build prints the Building line and docker's output", () => {
  const r = build("real");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Building sandcastle-base:\w+ \.\.\.$/m);
  assert.match(r.stderr, /^#0 building with "default" instance/);
  assert.match(r.stderr, /#2 0\.412 Get:1 http/);
  assert.doesNotMatch(r.stdout, /re-tagged from cache/);
});

test("a failed build prints the Building line, docker's output and the failure", () => {
  const r = build("fail");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^Building sandcastle-base:\w+ \.\.\.$/m);
  assert.match(r.stderr, /#2 ERROR: process "\/bin\/sh -c apt-get update" did not complete/);
  assert.match(r.stderr, /Building sandcastle-base:\w+ failed \(docker build exited 1\)/);
});
