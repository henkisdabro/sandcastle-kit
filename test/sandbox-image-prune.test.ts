// The base image's prune keeps a tag used or built within IMAGE_KEEP_DAYS (and any tag a live kit
// process used), instead of every tag but its own; and a build in which every step was cached prints
// one line, where a real build or a failure shows docker's output. Two real `sandcastle build`
// processes' worth of behaviour against a fake docker that keeps its images as files and prints
// BuildKit's plain progress. No Docker or network.
//
//   pnpm exec tsx --test test/sandbox-image-prune.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

// An image is a file under $STATE/img. `build` prints what FAKE_BUILD says: `cached` (every step
// cached), `real` (a RUN step ran) or `fail` (a step failed, exit 1).
const DOCKER = `#!/bin/sh
img="$FAKE_DOCKER_STATE/img"
mkdir -p "$img"
name() { echo "$1" | tr ':/' '__'; }
case "$1" in
  image)
    case "$2" in
      inspect) [ -e "$img/$(name "$3")" ]; exit $?;;
      ls) for f in "$img"/*; do [ -e "$f" ] || continue; b=$(basename "$f"); case "$b" in "$(name "$3")"_*) echo "$3:\${b#"$(name "$3")"_}";; esac; done; exit 0;;
      rm) rm -f "$img/$(name "$3")"; exit 0;;
    esac;;
  build)
    cat >/dev/null
    shift
    while [ "$1" != "-t" ]; do shift; done
    tag="$2"
    echo '#0 building with "default" instance using docker driver' >&2
    echo '#1 [internal] load build definition from Dockerfile' >&2
    echo '#1 DONE 0.0s' >&2
    echo '#2 [base 1/3] FROM docker.io/library/debian:12' >&2
    echo '#2 resolve docker.io/library/debian:12 done' >&2
    echo '#2 DONE 0.0s' >&2
    echo '#3 [base 2/3] RUN apt-get update' >&2
    case "$FAKE_BUILD" in
      cached) echo '#3 CACHED' >&2;;
      *) echo '#3 0.412 Get:1 http://deb.debian.org bookworm InRelease' >&2
         if [ "$FAKE_BUILD" = fail ]; then echo '#3 ERROR: process "/bin/sh -c apt-get update" did not complete successfully: exit code: 100' >&2; exit 1; fi
         echo '#3 DONE 3.2s' >&2;;
    esac
    echo '#4 exporting to image' >&2
    echo '#4 exporting layers done' >&2
    echo '#4 DONE 0.0s' >&2
    : > "$img/$(name "$tag")"
    exit 0;;
  tag)
    : > "$img/$(name "$3")"
    exit 0;;
esac
exit 0
`;

const DAY = 24 * 60 * 60 * 1000;

const machine = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-imageprune-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const state = join(dir, "state");
  mkdirSync(join(state, "img"), { recursive: true });
  return { dir, bin, state, cache: join(dir, "cache"), config: join(dir, "config") };
};
type Machine = ReturnType<typeof machine>;

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-imageprune-project-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "one", setup: [], gates: [{ name: "ok", command: "true" }] };\n`);
  return root;
};

const build = (m: Machine, how: "cached" | "real" | "fail") =>
  runKit(["build"], {
    cwd: project(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${m.bin}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_STATE: m.state,
      FAKE_BUILD: how,
      XDG_CACHE_HOME: m.cache,
      XDG_CONFIG_HOME: m.config,
      CLAUDE_CODE_VERSION: "1.0.0",
      CODEX_VERSION: "0.1.0",
      GIT_CEILING_DIRECTORIES: tmpdir(),
    },
  });

// An image of another kit checkout: the image, and (unless `usedAt` is left out) its use stamp.
const otherImage = (m: Machine, hash: string, usedAt?: number, pids: number[] = []) => {
  writeFileSync(join(m.state, "img", `sandcastle-base_${hash}`), "");
  if (usedAt === undefined) return;
  const dir = join(m.cache, "sandcastle-kit", "image-use");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `sandcastle-base_${hash}`), JSON.stringify({ at: usedAt, pids }));
};

const has = (m: Machine, hash: string) => existsSync(join(m.state, "img", `sandcastle-base_${hash}`));

test("a base image used a day ago by another checkout survives a build, one unused for a month does not", () => {
  const m = machine();
  otherImage(m, "recent", Date.now() - DAY);
  otherImage(m, "stale", Date.now() - 30 * DAY);
  const r = build(m, "real");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(has(m, "recent"), "the tag used yesterday was pruned");
  assert.ok(!has(m, "stale"), "the tag unused for 30 days was kept");
});

test("a base image with no use stamp is kept, and its days start from the build that saw it", () => {
  const m = machine();
  otherImage(m, "unstamped");
  assert.equal(build(m, "real").status, 0);
  assert.ok(has(m, "unstamped"));
  const stamp = JSON.parse(readFileSync(join(m.cache, "sandcastle-kit", "image-use", "sandcastle-base_unstamped"), "utf8")) as { at: number; pids: number[] };
  assert.ok(Math.abs(Date.now() - stamp.at) < 60_000, `stamped at ${stamp.at}`);
  // The build saw the tag, it did not use it: a long run that pruned must not keep it alive.
  assert.deepEqual(stamp.pids, []);
});

test("an old base image a live kit process used survives, and is pruned once that process is gone", async () => {
  const m = machine();
  // A process whose command line names the kit's entry point, as a run's does.
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "src/cli.ts"], { stdio: "ignore" });
  try {
    otherImage(m, "running", Date.now() - 30 * DAY, [live.pid!]);
    assert.equal(build(m, "real").status, 0);
    assert.ok(has(m, "running"), "a tag a live run uses was pruned");
  } finally {
    live.kill();
    await new Promise((r) => live.once("exit", r));
  }
  // Prune runs when a build does: take the freshly built tag away so the next run builds again.
  for (const f of readdirSync(join(m.state, "img"))) if (f !== "sandcastle-base_running") rmSync(join(m.state, "img", f));
  assert.equal(build(m, "real").status, 0);
  assert.ok(!has(m, "running"), "the tag stayed after its run ended");
});

test("the built base image is stamped as used now", () => {
  const m = machine();
  assert.equal(build(m, "real").status, 0);
  const dir = join(m.cache, "sandcastle-kit", "image-use");
  const files = execFileSync("ls", [dir], { encoding: "utf8" }).trim().split("\n");
  assert.equal(files.length, 1, files.join(","));
  assert.match(files[0]!, /^sandcastle-base_\w+$/);
});

test("a build in which every step was cached prints one line, not docker's output", () => {
  const m = machine();
  const r = build(m, "cached");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Image sandcastle-base:\w+ re-tagged from cache\n/);
  assert.ok(!/#\d/.test(r.stdout + r.stderr), `docker's output shown:\n${r.stdout}${r.stderr}`);
});

test("a build that ran a step shows docker's whole output, from its first line", () => {
  const m = machine();
  const r = build(m, "real");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /^#0 building with "default" instance/);
  assert.match(r.stderr, /#3 0\.412 Get:1 http/);
  assert.match(r.stderr, /#4 DONE 0\.0s/);
  assert.ok(!/re-tagged from cache/.test(r.stdout));
});

test("a failed build shows docker's output and names the failure", () => {
  const m = machine();
  const r = build(m, "fail");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /#3 ERROR: process "\/bin\/sh -c apt-get update" did not complete/);
  assert.match(r.stderr, /Building sandcastle-base:\w+ failed \(docker build exited 1\)/);
});
