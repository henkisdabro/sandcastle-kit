// The stop before a sandbox's close (`stopSandboxContainer`, through `checkBeforeClose`) stops the container the
// handle names (Sandcastle 0.14.0's `sandboxId`) first - `docker ps` asks for that container alone, its mount of the
// worktree still checked - and then any other running sandbox container that mounts the worktree (one an earlier open
// left when its removal failed), never one that mounts another. A handle with no name, or a name of another shape, is
// found by its mount alone, as before. A fake `docker` on PATH that keeps which containers run: no Docker, model or network.
//
//   pnpm test:file test/sandbox-stop-by-name.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { stopSandboxContainer } from "../src/sandbox.ts";

const NAME = "sandcastle-0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

/**
 * A docker with running containers by id: `named` (the handle's, called NAME), and the `others` given, each with the
 * mount source it lists. `ps` with NAME's filter lists `named` while it runs, the `sandcastle-` filter every running one;
 * `stop` takes a container off the running list. Every call is logged.
 */
const fake = (worktree: string, others: Record<string, string> = {}) => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-stop-by-name-")));
  const bin = join(state, "bin");
  mkdirSync(join(state, "mounts"), { recursive: true });
  mkdirSync(bin);
  const mounts: Record<string, string> = { named: worktree, ...others };
  for (const [id, source] of Object.entries(mounts)) writeFileSync(join(state, "mounts", id), `${source}\n`);
  writeFileSync(join(state, "running"), Object.keys(mounts).map((id) => `${id}\n`).join(""));
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
s="${state}"
echo "$1 $2 $3 $4" >> "$s/calls"
case "$1" in
  ps) case "$*" in
        *"name=^${NAME}\\$"*) grep -x named "$s/running" ;;
        *"name=^sandcastle-") cat "$s/running" ;;
      esac ;;
  inspect) cat "$s/mounts/$2" ;;
  stop) grep -vx "$4" "$s/running" > "$s/running.new"; mv "$s/running.new" "$s/running" ;;
  *) exit 1 ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(state, "calls"), "");
  const lines = (f: string) => readFileSync(join(state, f), "utf8").split("\n").filter(Boolean);
  return { bin, calls: () => lines("calls"), stops: () => lines("calls").filter((c) => c.startsWith("stop ")).map((c) => c.split(" ")[3]), running: () => lines("running") };
};

const withPath = async <T>(bin: string, fn: () => Promise<T>) => {
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
};

const worktree = () => realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-stop-wt-")));

test("the named container is asked for by its name and stopped first, its mount checked", async () => {
  const wt = worktree();
  const docker = fake(wt);
  assert.deepEqual(await withPath(docker.bin, () => stopSandboxContainer(wt, NAME)), []);
  assert.equal(docker.calls()[0], `ps -q --filter name=^${NAME}$`);
  assert.ok(docker.calls().includes("inspect named --format {{range .Mounts}}{{.Source}}"), "the mount is still checked");
  assert.deepEqual(docker.stops(), ["named"], "stopped once, by the named search");
});

test("another running container that mounts the worktree is stopped after the named one; one of another worktree is left", async () => {
  const wt = worktree();
  const docker = fake(wt, { leftover: wt, theirs: worktree() });
  assert.deepEqual(await withPath(docker.bin, () => stopSandboxContainer(wt, NAME)), []);
  assert.deepEqual(docker.stops(), ["named", "leftover"]);
  assert.deepEqual(docker.running(), ["theirs"]);
});

test("with no name, or a name of another shape, the containers are found by their mount as before", async () => {
  for (const name of [undefined, "--all"]) {
    const wt = worktree();
    const docker = fake(wt, { leftover: wt });
    await withPath(docker.bin, () => stopSandboxContainer(wt, name));
    assert.equal(docker.calls()[0], "ps -q --filter name=^sandcastle-");
    assert.deepEqual(docker.stops().sort(), ["leftover", "named"]);
  }
});
