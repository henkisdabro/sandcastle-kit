// A command that runs host git over the shared `.git` (`run`, `land`, `gates`, `clean`) takes the run lock and
// reaps the sandboxes a killed run left working before it checks the start baseline and pins the config: a
// container still alive can write `.git` until it is reaped, and a write between the check and the reap would be
// neither refused nor pinned. Against a fake `docker` on PATH; no Docker, model calls or network.
//
//   pnpm test:file test/guard-start-reap-order.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, holdAndReap, recordGitConfigEnd, recordGitConfigStart } from "../src/guard.ts";
import { OperatorError } from "../src/errors.ts";
import { kitLikeProcess } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

/** A project, and a `docker` that lists one running sandbox mounting the project's worktree; removing it plants a filter in the shared config, as a container's last write would. */
const fixture = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-reap-order-")));
  const root = join(dir, "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1" in
  ps) echo c0ffee ;;
  inspect) echo "${root}/.sandcastle/worktrees/agent-issue-1" ;;
  rm) git -C "${root}" config filter.evil.clean "touch owned" ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const calls = () => {
    try {
      return readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { project: { root, name: "reap-order", baseBranch: "main" } as Project, bin, calls };
};

const withPath = async <T>(bin: string, fn: () => Promise<T> | T): Promise<T> => {
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
};

test("a container's last write before it is reaped is refused by the baseline check that follows the reap", async () => {
  const { project, bin, calls } = fixture();
  // The previous run ended cleanly with nothing planted.
  recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run"));
  recordGitConfigEnd(project);
  await withPath(bin, () => quietly(() => holdAndReap(project)));
  assert.ok(calls().some((c) => c.startsWith("rm -f c0ffee")), calls().join("\n"));
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), (e: Error) => /filter\.evil\.clean added/.test(e.message));
});

test("a refused run lock reaps nothing: another run's containers are not ours to stop", async () => {
  const { project, bin, calls } = fixture();
  mkdirSync(join(project.root, ".sandcastle", "logs"), { recursive: true });
  const kit = kitLikeProcess();
  try {
    writeFileSync(join(project.root, ".sandcastle", "logs", "run.lock"), `${kit.pid} x t\n`);
    await withPath(bin, () => assert.rejects(async () => holdAndReap(project), (e: Error) => e instanceof OperatorError && /is live/.test(e.message)));
  } finally {
    kit.kill();
  }
  assert.deepEqual(calls(), []);
});

// burndown() and the commands need Docker; the order at each is held here instead.
test("a run's start, land, gates and clean hold the lock and reap before the baseline check and the pins", () => {
  const read = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const ordered = (label: string, text: string, from: number) => {
    const at = (needle: string) => {
      const i = text.indexOf(needle, from);
      assert.ok(i >= 0, `${label}: ${needle}`);
      return i;
    };
    assert.ok(at("holdAndReap(project)") < at("assertGitConfigBaseline("), `${label}: the reap comes after the baseline check`);
    assert.ok(at("holdAndReap(project)") < at("pinHostGitConfig("), `${label}: the reap comes after the pins`);
    assert.ok(at("holdAndReap(project)") < at("recordGitConfigStart("), `${label}: the lock is taken after the start is recorded`);
  };
  const burndown = read("burndown.ts");
  ordered("run", burndown, burndown.indexOf("export const burndown = "));
  const cli = read("cli.ts");
  for (const command of ["gates", "land", "clean"]) ordered(command, cli, cli.indexOf(`case "${command}": {`));
  // The reap is not repeated ahead of the lock anywhere: `reapOrphans` outside the lock would stop a live run's containers.
  assert.doesNotMatch(burndown, /\n\s*reapOrphans\(project\);/);
  assert.match(read("guard.ts"), /export const holdAndReap = \(project: Project\) => \{\n\s*lockRun\(project\);\n\s*reapOrphans\(project\);/);
});
