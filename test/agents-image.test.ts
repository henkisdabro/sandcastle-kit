// The agents image: Claude Code and Codex are built into `sandcastle-agents:<hash>` and copied onto the
// project's image by a last, thin build, so a release rebuilds that image and a copy layer per project
// and leaves the base's and the project layer's tags (and so Docker's cache for the layer) where they
// were. Two or three real `sandcastle build` processes against a fake docker that keeps its images as
// files and records every build's Dockerfile. No Docker or network.
//
//   pnpm test:file test/agents-image.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runKit } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { changedDockerfiles } = await import("../src/gates.ts");

// An image is a file under $STATE/img. A build logs `build <tag> <build args>` and keeps the Dockerfile it
// was given on stdin under $STATE/dockerfile/, named by its tag.
const DOCKER = `#!/bin/sh
state="$FAKE_DOCKER_STATE"
img="$state/img"
mkdir -p "$img" "$state/dockerfile"
name() { echo "$1" | tr ':/' '__'; }
case "$1" in
  image)
    case "$2" in
      inspect) [ -e "$img/$(name "$3")" ]; exit $?;;
      ls) for f in "$img"/*; do [ -e "$f" ] || continue; b=$(basename "$f"); case "$b" in "$(name "$3")"_*) echo "$3:\${b#"$(name "$3")"_}";; esac; done; exit 0;;
      rm) rm -f "$img/$(name "$3")"; exit 0;;
    esac;;
  build)
    shift
    tag=""; args=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) tag="$2"; shift;;
        --build-arg) args="$args $2"; shift;;
      esac
      shift
    done
    cat > "$state/dockerfile/$(name "$tag")"
    echo "build $tag$args" >> "$state/log"
    : > "$img/$(name "$tag")"
    exit 0;;
  tag)
    : > "$img/$(name "$3")"
    exit 0;;
esac
exit 0
`;

const machine = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-agentsimage-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  const state = join(dir, "state");
  mkdirSync(state);
  return { bin, state, cache: join(dir, "cache"), config: join(dir, "config") };
};
type Machine = ReturnType<typeof machine>;

const project = (layer: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-agentsimage-project-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".sandcastle"));
  const dockerfile = layer ? `, dockerfile: ".sandcastle/Dockerfile"` : "";
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "one", setup: []${dockerfile}, gates: [{ name: "ok", command: "true" }] };\n`);
  if (layer) writeFileSync(join(root, ".sandcastle/Dockerfile"), "ARG BASE=sandcastle-base:latest\nFROM ${BASE}\nRUN true\n");
  return root;
};

/** `sandcastle build` with the given Claude Code version; returns the tag it printed, the image a run would start from. */
const build = (m: Machine, root: string, claude: string, args: string[] = []) => {
  const r = runKit(["build", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${m.bin}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_STATE: m.state,
      XDG_CACHE_HOME: m.cache,
      XDG_CONFIG_HOME: m.config,
      CLAUDE_CODE_VERSION: claude,
      CODEX_VERSION: "0.1.0",
      GIT_CEILING_DIRECTORIES: tmpdir(),
    },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.trim().split("\n").pop()!;
};

/** The builds so far, in order: tag and build args. */
const builds = (m: Machine) => {
  const file = join(m.state, "log");
  const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
  return lines.map((l) => {
    const [, tag, ...args] = l.split(" ");
    return { tag: tag!, args: Object.fromEntries(args.map((a) => a.split("=") as [string, string])) as Record<string, string> };
  });
};
const repoOf = (tag: string) => tag.split(":")[0]!;
const dockerfileOf = (m: Machine, tag: string) => readFileSync(join(m.state, "dockerfile", tag.replace(/[:/]/g, "_")), "utf8");

test("a new Claude Code version builds the agents image and the final image again, and leaves the base and the project layer as they were", () => {
  const m = machine();
  const root = project(true);
  const first = build(m, root, "1.0.0");
  const before = builds(m);
  assert.deepEqual(before.map((b) => repoOf(b.tag)), ["sandcastle-base", "sandcastle-agents", "sandcastle-one", "sandcastle-one-run"]);
  assert.equal(before[3]!.tag, first, "the tag a build prints is the final image's");

  const second = build(m, root, "2.0.0");
  const after = builds(m).slice(before.length);
  // Only the agents image and the copy layer: the base and the layer FROM it are found built.
  assert.deepEqual(after.map((b) => repoOf(b.tag)), ["sandcastle-agents", "sandcastle-one-run"]);
  assert.notEqual(after[0]!.tag, before[1]!.tag);
  assert.notEqual(second, first);
  assert.equal(after[0]!.args.CLAUDE_CODE_VERSION, "2.0.0");
  assert.equal(after[0]!.args.CODEX_VERSION, "0.1.0");
  assert.equal(after[0]!.args.BASE, before[0]!.tag, "the agents image builds FROM the same base as before");
  // The final image is FROM the layer built in the first run, and copies from the new agents image.
  const text = dockerfileOf(m, second);
  assert.equal(text.split("\n")[0], `FROM ${before[2]!.tag}`);
  assert.match(text, new RegExp(`^COPY --from=${after[0]!.tag} `, "m"));
  assert.ok(!text.includes(before[1]!.tag), "the final image still copies from the old agents image");

  // The same versions again: everything is found built.
  assert.equal(build(m, root, "2.0.0"), second);
  assert.equal(builds(m).length, before.length + after.length);
});

test("a project with no dockerfile gets a final image FROM the base", () => {
  const m = machine();
  const tag = build(m, project(false), "1.0.0");
  const all = builds(m);
  assert.deepEqual(all.map((b) => repoOf(b.tag)), ["sandcastle-base", "sandcastle-agents", "sandcastle-one-run"]);
  assert.equal(all[2]!.tag, tag);
  const text = dockerfileOf(m, tag);
  assert.equal(text.split("\n")[0], `FROM ${all[0]!.tag}`);
  assert.match(text, new RegExp(`^COPY --from=${all[1]!.tag} `, "m"));
});

test("the final image copies both CLIs from where the agents Dockerfile puts them, as the agent user, with ~/.local/bin on PATH", () => {
  const m = machine();
  const tag = build(m, project(true), "1.0.0");
  const lines = dockerfileOf(m, tag).split("\n");
  const copies = lines.filter((l) => l.startsWith("COPY "));
  assert.equal(copies.length, 3, lines.join("\n"));
  const agents = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docker", "agents.Dockerfile"), "utf8");
  const ids = `${execFileSync("id", ["-u"], { encoding: "utf8" }).trim()}:${execFileSync("id", ["-g"], { encoding: "utf8" }).trim()}`;
  // Codex: the package and its `bin` link, out of the prefix the agents Dockerfile installs it to.
  const prefix = /npm install -g --prefix (\S+) @openai\/codex/.exec(agents)?.[1];
  assert.equal(prefix, "/opt/codex");
  assert.ok(copies.some((c) => c.endsWith(` ${prefix}/lib/node_modules/@openai/codex /usr/local/lib/node_modules/@openai/codex`)), copies.join("\n"));
  assert.ok(copies.some((c) => c.endsWith(` ${prefix}/bin /usr/local/bin`)), copies.join("\n"));
  // Claude Code: the agent user's ~/.local, owned by it (a copy is root's otherwise).
  assert.ok(copies.some((c) => c.includes(` --chown=${ids} /home/agent/.local /home/agent/.local`)), copies.join("\n"));
  assert.ok(lines.includes(`USER ${ids}`));
  assert.ok(lines.includes('ENV PATH="/home/agent/.local/bin:$PATH"'));
});

test("--force builds all four images again", () => {
  const m = machine();
  const root = project(true);
  build(m, root, "1.0.0");
  const before = builds(m).length;
  build(m, root, "1.0.0", ["--force"]);
  assert.deepEqual(builds(m).slice(before).map((b) => repoOf(b.tag)), ["sandcastle-base", "sandcastle-agents", "sandcastle-one", "sandcastle-one-run"]);
});

test("a run's merges that changed the agents Dockerfile are named among the Dockerfiles the verify ran without", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-agentsimage-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Operator Example");
  git("config", "user.email", "operator@example.com");
  git("config", "commit.gpgsign", "false");
  const commit = (file: string) => {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), `${Math.random()}\n`);
    git("add", file);
    git("commit", "-q", "-m", `change ${file}`);
    return git("rev-parse", "HEAD");
  };
  const start = commit("src/a.ts");
  commit("docker/agents.Dockerfile");
  assert.deepEqual(changedDockerfiles({ root }, start, "main"), ["docker/agents.Dockerfile"]);
});
