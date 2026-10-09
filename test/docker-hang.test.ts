// `reapOrphans` and `removeExitedSandboxes` against a `docker` that never answers (a hung daemon): each
// names the daemon within its limit instead of hanging the run's start or `sandcastle clean`. The fake is a
// shell script on PATH that `exec`s `sleep`, so the limit's SIGKILL ends docker itself, as with the real CLI.
//
//   pnpm test:file test/docker-hang.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";
import { reapOrphans, removeExitedSandboxes } from "../src/sandbox.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-dockerhang-")));

// A docker that answers `ps` with one container id, and hangs on whichever command is named in `hangOn`.
const fakeDocker = (hangOn: string) => {
  const bin = join(tmp(), "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "docker");
  writeFileSync(
    script,
    `#!/bin/sh
case "$1" in
  ${hangOn}) exec sleep 60 ;;
  ps) echo abc ;;
  inspect) echo "$PROJECT_ROOT/.sandcastle/worktrees/agent-issue-1" ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(script, 0o755);
  return bin;
};

const withDocker = <T>(bin: string, root: string, fn: () => T): T => {
  const before = { PATH: process.env.PATH, PROJECT_ROOT: process.env.PROJECT_ROOT };
  process.env.PATH = `${bin}${delimiter}${before.PATH}`;
  process.env.PROJECT_ROOT = root;
  try {
    return fn();
  } finally {
    process.env.PATH = before.PATH;
    if (before.PROJECT_ROOT === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = before.PROJECT_ROOT;
  }
};

const hung = /docker did not answer `docker (ps|inspect|rm)` within 0\.3 s/;

for (const command of ["ps", "inspect", "rm"]) {
  test(`a hung docker ${command} is named by the reap of a killed run's sandboxes, not waited for`, () => {
    const root = tmp();
    const project = { root, name: "demo" } as Project;
    assert.throws(() => withDocker(fakeDocker(command), root, () => reapOrphans(project, 300)), (e) => e instanceof OperatorError && hung.test(e.message) && e.message.includes(command));
  });

  test(`a hung docker ${command} is named by the removal of exited sandboxes, not waited for`, () => {
    const root = tmp();
    const project = { root, name: "demo" } as Project;
    assert.throws(() => withDocker(fakeDocker(command), root, () => removeExitedSandboxes(project, 300)), (e) => e instanceof OperatorError && hung.test(e.message) && e.message.includes(command));
  });
}
