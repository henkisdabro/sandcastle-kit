// A project's layer build FROM the base image, while another project builds a base of a different
// tag: that build prunes every other base tag, so unless the layer build is inside the same
// machine-wide lock as the base step, `FROM sandcastle-base:<tag>` can resolve to an image that is
// gone. Two real `sandcastle build` processes against a fake docker that keeps its images as files
// (as test/sandbox-image-lock.test.ts's does) and whose layer build fails when its base image is not
// there once it resolves `FROM`. No Docker or network.
//
//   node --test test/sandbox-layer-lock.test.ts

import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { startKit } from "./cli-spawn.ts";

// An image is a file under $STATE/img. A build with `--build-arg BASE=<tag>` is a layer build: it
// logs that it started, then (with `FAKE_LAYER_HOLDS`) waits until $STATE/go exists, at most 15 s -
// the time the daemon takes to resolve `FROM` - and only then fails if the base image is missing.
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
    tag=""; base=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) tag="$2"; shift;;
        BASE=*) base="\${1#BASE=}";;
      esac
      shift
    done
    echo "start $tag" >> "$FAKE_DOCKER_STATE/log"
    if [ -n "$base" ]; then
      if [ -n "$FAKE_LAYER_HOLDS" ]; then
        n=0
        while [ ! -e "$FAKE_DOCKER_STATE/go" ] && [ $n -lt 150 ]; do sleep 0.1; n=$((n + 1)); done
      fi
      if [ ! -e "$img/$(name "$base")" ]; then
        echo "ERROR: failed to resolve source metadata for $base: not found" >&2
        exit 1
      fi
    else
      sleep 1
    fi
    : > "$img/$(name "$tag")"
    echo "end $tag" >> "$FAKE_DOCKER_STATE/log"
    exit 0;;
  tag)
    if [ ! -e "$img/$(name "$2")" ]; then
      echo "Error response from daemon: No such image: $2" >&2
      exit 1
    fi
    : > "$img/$(name "$3")"
    exit 0;;
esac
exit 0
`;

const machine = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-layerlock-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const state = join(dir, "state");
  mkdirSync(state);
  return { dir, bin, state, cache: join(dir, "cache"), config: join(dir, "config") };
};

type Machine = ReturnType<typeof machine>;

const project = (name: string, layer: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-layerlock-project-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".sandcastle"));
  const dockerfile = layer ? `, dockerfile: ".sandcastle/Dockerfile"` : "";
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "${name}", setup: []${dockerfile}, gates: [{ name: "ok", command: "true" }] };\n`);
  if (layer) writeFileSync(join(root, ".sandcastle/Dockerfile"), "ARG BASE=sandcastle-base:latest\nFROM ${BASE}\nRUN true\n");
  return root;
};

const env = (m: Machine, claude: string, extra: Record<string, string> = {}) => ({
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

const WAITING = /Waiting for another sandcastle build of the base image/;

const finished = (child: ChildProcess, onOutput: (out: string) => void = () => {}) =>
  new Promise<{ status: number | null; out: string }>((resolve) => {
    let out = "";
    const add = (d: Buffer) => {
      out += d;
      onOutput(out);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.once("exit", (status) => resolve({ status, out }));
  });

const log = (m: Machine) => (existsSync(join(m.state, "log")) ? readFileSync(join(m.state, "log"), "utf8").trim().split("\n") : []);

const until = async (what: string, ready: () => boolean) => {
  for (let i = 0; i < 300 && !ready(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(ready(), `${what} never happened`);
};

test("a layer build still finds its base image when another project builds a base of a different tag meanwhile", async () => {
  const m = machine();
  const go = join(m.state, "go");
  const layer = finished(startKit(["build"], { cwd: project("one", true), env: env(m, "1.0.0", { FAKE_LAYER_HOLDS: "1" }), stdio: ["ignore", "pipe", "pipe"] }));
  // The layer build is under way, resolving `FROM` the 1.0.0 base.
  await until("the layer build's start", () => log(m).some((l) => l.startsWith("start sandcastle-one:")));
  // The other project's build of a 2.0.0 base prunes the 1.0.0 one - unless it must wait for the layer.
  // Whichever it does, the layer's `FROM` resolves once that build has either waited or finished.
  const other = finished(startKit(["build"], { cwd: project("two", false), env: env(m, "2.0.0"), stdio: ["ignore", "pipe", "pipe"] }), (out) => {
    if (WAITING.test(out)) writeFileSync(go, "");
  });
  const done = await Promise.race([other.then(() => "other"), new Promise((r) => setTimeout(r, 8000, "timeout"))]);
  writeFileSync(go, "");
  const [a, b] = await Promise.all([layer, other]);
  assert.notEqual(done, "timeout", "the other build neither waited nor finished");
  assert.equal(a.status, 0, `the layer build failed:\n${a.out}`);
  assert.equal(b.status, 0, b.out);
  assert.match(b.out, WAITING);
  assert.equal(log(m).filter((l) => l.startsWith("end sandcastle-one:")).length, 1, log(m).join("\n"));
});
