// A repository whose base branch has no commit yet (a fresh `git init` with a config) is refused by `gates` and
// `run` with one line that names the cause and the fix, not a Node stack trace from `git rev-parse`. A stub
// `docker`, a temp repo: no Docker, model or network.
//
//   pnpm test:file test/unborn-base.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";
import { dockerStub } from "./docker-stub.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

/** A repository on `main` with a config and no commit. */
const unborn = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-unborn-base-")));
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"], { env });
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", gates: [{ name: "g", command: "true" }], tracker: "files" };\n`);
  return root;
};

const kit = (root: string, ...args: string[]) => {
  const docker = dockerStub(true);
  const home = mkdtempSync(join(tmpdir(), "sandcastle-unborn-base-cfg-"));
  return runKit(args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: docker.first(process.env.PATH), HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: join(home, "cache"), GIT_CEILING_DIRECTORIES: tmpdir() },
  });
};

for (const command of [["gates"], ["run"], ["run", "--detach"]]) {
  test(`sandcastle ${command.join(" ")} on a base branch with no commit names the fix and prints no stack trace`, () => {
    const r = kit(unborn(), ...command);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the base branch main has no commit yet/);
    assert.match(r.stderr, /Commit something on main first/);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at |fatal:|ambiguous argument/);
  });
}
