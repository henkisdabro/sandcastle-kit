// Two projects building the base image at the same moment: the base step (build, prune of
// superseded tags, `docker tag`) is one machine-wide critical section, so the second build waits and
// then finds the image built; and a docker failure is a refusal naming the image, not a stack trace.
// Two real `sandcastle build` processes against a fake docker that keeps its images as files, shares
// no state but the cache directory, and fails as docker does when a tag names an image that is not
// there. No Docker or network.
//
//   pnpm exec tsx --test test/sandbox-image-lock.test.ts

import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runKit, startKit } from "./cli-spawn.ts";

// An image is a file under $STATE/img. A build takes a second and logs when it starts and ends; `tag`
// of an image that is not there fails with the daemon's words; `FAKE_TAG_FAILS` makes every tag fail.
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
    echo "start $tag" >> "$FAKE_DOCKER_STATE/log"
    sleep 1
    : > "$img/$(name "$tag")"
    echo "end $tag" >> "$FAKE_DOCKER_STATE/log"
    exit 0;;
  tag)
    if [ -n "$FAKE_TAG_FAILS" ] || [ ! -e "$img/$(name "$2")" ]; then
      echo "Error response from daemon: No such image: $2" >&2
      exit 1
    fi
    : > "$img/$(name "$3")"
    exit 0;;
esac
exit 0
`;

const machine = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-imagelock-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const state = join(dir, "state");
  mkdirSync(state);
  return { dir, bin, state, cache: join(dir, "cache"), config: join(dir, "config") };
};

const project = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-imagelock-project-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "${name}", setup: [], gates: [{ name: "ok", command: "true" }] };\n`);
  return root;
};

const env = (m: ReturnType<typeof machine>, claude: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  PATH: `${m.bin}${delimiter}${process.env.PATH}`,
  FAKE_DOCKER_STATE: m.state,
  XDG_CACHE_HOME: m.cache,
  XDG_CONFIG_HOME: m.config,
  // Exact versions: nothing is resolved over the network.
  CLAUDE_CODE_VERSION: claude,
  CODEX_VERSION: "0.1.0",
  GIT_CEILING_DIRECTORIES: tmpdir(),
  ...extra,
});

const buildInBackground = (m: ReturnType<typeof machine>, name: string, claude: string) => {
  const child = startKit(["build"], { cwd: project(name), env: env(m, claude), stdio: ["ignore", "pipe", "pipe"] });
  return finished(child);
};

const finished = (child: ChildProcess) =>
  new Promise<{ status: number | null; out: string }>((resolve) => {
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.once("exit", (status) => resolve({ status, out }));
  });

const log = (m: ReturnType<typeof machine>) => (existsSync(join(m.state, "log")) ? readFileSync(join(m.state, "log"), "utf8").trim().split("\n") : []);

test("two projects building the same new base tag build it once, and both succeed", async () => {
  const m = machine();
  const [a, b] = await Promise.all([buildInBackground(m, "one", "1.0.0"), buildInBackground(m, "two", "1.0.0")]);
  assert.equal(a.status, 0, a.out);
  assert.equal(b.status, 0, b.out);
  assert.equal(log(m).filter((l) => l.startsWith("start ")).length, 1, `built twice:\n${log(m).join("\n")}`);
  assert.match(a.out + b.out, /Waiting for another sandcastle build of the base image/);
});

test("two projects building different base tags build one after the other, each tagging its own image", async () => {
  const m = machine();
  const [a, b] = await Promise.all([buildInBackground(m, "one", "1.0.0"), buildInBackground(m, "two", "2.0.0")]);
  assert.equal(a.status, 0, a.out);
  assert.equal(b.status, 0, b.out);
  const lines = log(m);
  assert.equal(lines.length, 4, lines.join("\n"));
  // start X, end X, start Y, end Y - never start X, start Y.
  assert.equal(lines[0]!.replace("start ", ""), lines[1]!.replace("end ", ""), lines.join("\n"));
  assert.equal(lines[2]!.replace("start ", ""), lines[3]!.replace("end ", ""), lines.join("\n"));
});

test("a failing docker tag is a refusal naming the image and docker's message, with no stack trace", () => {
  const m = machine();
  const r = runKit(["build"], { cwd: project("one"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env(m, "1.0.0", { FAKE_TAG_FAILS: "1" }) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Docker failed tagging sandcastle-base:\w+ as sandcastle-base:latest .*No such image: sandcastle-base:\w+/);
  assert.ok(!r.stderr.split("\n").some((l) => /^\s+at /.test(l)), `stack trace in:\n${r.stderr}`);
});
