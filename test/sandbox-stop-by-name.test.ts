// The stop before a sandbox's close (`stopSandboxContainer`, through `checkBeforeClose`) addresses the container by the
// name Sandcastle's handle gives (0.14.0's `sandboxId`): `docker ps` asks for that container alone, its mount of the
// worktree is still checked, and it is stopped. A handle with no name, or a name of another shape, is found by its mount
// as before. A fake `docker` on PATH: no Docker, model or network.
//
//   pnpm test:file test/sandbox-stop-by-name.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { stopSandboxContainer } from "../src/sandbox.ts";

const NAME = "sandcastle-0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

/** A docker with one running container, `c1`, that mounts `worktree`; every call is logged. `ps` honours a name filter for NAME. */
const fake = (worktree: string) => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-stop-by-name-")));
  const bin = join(state, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
echo "$*" >> "${state}/calls"
case "$1" in
  ps) case "$*" in *"name=^${NAME}\\$"*|*"name=^sandcastle-") echo c1 ;; esac ;;
  inspect) printf '%s\\n' "${worktree}" ;;
  stop) ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(state, "calls"), "");
  return { bin, calls: () => readFileSync(join(state, "calls"), "utf8").trim().split("\n") };
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

test("a named container is asked for by its name, its mount checked, and stopped", async () => {
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-stop-wt-")));
  const docker = fake(worktree);
  assert.deepEqual(await withPath(docker.bin, () => stopSandboxContainer(worktree, NAME)), []);
  assert.equal(docker.calls()[0], `ps -q --filter name=^${NAME}$`);
  assert.ok(docker.calls().some((c) => c.startsWith("inspect c1 ")), "the mount is still checked");
  assert.ok(docker.calls().includes("stop -t 3 c1"));
});

test("with no name, or a name of another shape, the container is found by its mount as before", async () => {
  for (const name of [undefined, "--all"]) {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-stop-wt-")));
    const docker = fake(worktree);
    await withPath(docker.bin, () => stopSandboxContainer(worktree, name));
    assert.equal(docker.calls()[0], "ps -q --filter name=^sandcastle-");
    assert.ok(docker.calls().includes("stop -t 3 c1"));
  }
});
