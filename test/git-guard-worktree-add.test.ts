// The git guard refuses `git worktree add` against the shared repo (it registers a record with a
// container path that a killed pass leaves behind) and allows it in a scratch repository, named with an
// absolute `git -C`. `worktree remove --force` stays allowed.
//
//   node --test test/git-guard-worktree-add.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT } from "../src/sandbox.ts";

const GUARD = join(KIT, "container/git-guard.sh");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k) && k !== "CLAUDE_PROJECT_DIR"));

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-git-guard-wtadd-")));
after(() => rmSync(root, { recursive: true, force: true }));
const main = join(root, "main");
const worktree = join(root, "agent-1");
const scratch = join(root, "scratch");
for (const dir of [main, scratch]) mkdirSync(dir);
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
git(main, "init", "-q", "-b", "main");
git(main, "commit", "-q", "--allow-empty", "-m", "start");
git(main, "worktree", "add", "-q", "-b", "agent/issue-1", worktree);
git(scratch, "init", "-q", "-b", "main");

const bash = (command: string) =>
  spawnSync("bash", [GUARD], {
    input: JSON.stringify({ cwd: worktree, tool_input: { command } }),
    encoding: "utf8",
    env: { ...env, CLAUDE_PROJECT_DIR: worktree },
  });

test("git worktree add in the project is refused, with the way to read the base instead", () => {
  for (const cmd of [
    "git worktree add --detach /tmp/base main",
    "git worktree add -b x /tmp/x",
    `git -C ${worktree} worktree add /tmp/x main`,
    `git -C ${main} worktree add /tmp/x main`,
    "cd /tmp && git worktree add /tmp/x main",
    "FOO=1 git worktree add /tmp/x main",
    "git worktree add",
  ]) {
    const r = bash(cmd);
    assert.equal(r.status, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /git worktree add/);
    assert.match(r.stderr, /git show <base>:<path>/);
    assert.match(r.stderr, /git archive <base>/);
  }
});

test("git worktree add in a scratch repository, and the other worktree commands, still pass", () => {
  for (const cmd of [
    `git -C ${scratch} worktree add --detach ${root}/s1 main`,
    `git -C '${scratch}' worktree add ${root}/s2`,
    "git worktree remove --force /tmp/x",
    "git worktree list",
    'git commit -m "mention git worktree add in prose"',
  ]) {
    const r = bash(cmd);
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
  }
});
