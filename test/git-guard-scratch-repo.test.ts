// The git guard looks at where a command runs: update-ref, gc and prune with `git -C <path>` in a
// scratch repository outside the shared .git are allowed, a worktree of the shared repo is not, and
// push is refused wherever it runs (its danger is the destination).
//
//   pnpm exec tsx --test test/git-guard-scratch-repo.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT } from "../src/sandbox.ts";

const GUARD = join(KIT, "container/git-guard.sh");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-git-guard-scratch-")));
after(() => rmSync(root, { recursive: true, force: true }));
const main = join(root, "main");
const worktree = join(root, "agent-1");
const scratch = join(root, "scratch");
const bare = join(root, "origin.git");
for (const dir of [main, scratch]) mkdirSync(dir);
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
git(main, "init", "-q", "-b", "main");
git(main, "commit", "-q", "--allow-empty", "-m", "start");
git(main, "worktree", "add", "-q", "-b", "agent/issue-1", worktree);
git(scratch, "init", "-q", "-b", "main");
execFileSync("git", ["init", "-q", "--bare", bare], { env });

// What Claude Code pipes to a PreToolUse hook; the agent's cwd is its own worktree.
const bash = (command: string, cwd = worktree) =>
  spawnSync("bash", [GUARD], { input: JSON.stringify({ cwd, tool_input: { command } }), encoding: "utf8", env });

const ALLOWED = [
  `git -C ${scratch} update-ref refs/remotes/origin/main HEAD`,
  `git -C ${scratch} gc --prune=now`,
  `git -C ${scratch} prune`,
  `git -C ${bare} update-ref refs/heads/main HEAD`,
  `sudo git -C ${scratch} gc`,
  `git -c gc.auto=0 -C ${scratch} prune`,
  `git -C ${scratch} update-ref -d refs/heads/x && git -C ${bare} prune`,
];

const BLOCKED = [
  // a worktree of the shared repo resolves to the shared common dir
  `git -C ${worktree} update-ref -d refs/heads/main`,
  `git -C ${main} gc`,
  `git -C ${worktree} prune`,
  `git -C ${join(worktree, "..", "main")} update-ref -d refs/heads/main`,
  // no -C: the hook's cwd is the shell's, and a leading cd is not parsed
  `cd ${scratch} && git update-ref -d refs/heads/x`,
  // one refused command in the line refuses it
  `git -C ${scratch} gc; git update-ref -d refs/heads/main`,
  `git -C ${scratch} gc && git -C ${worktree} prune`,
  // unresolvable paths, and a git dir named outright
  `git -C ${join(root, "missing")} update-ref -d refs/heads/x`,
  `git -C '${scratch}' gc`,
  "git -C $SCRATCH gc",
  `git --git-dir=${join(main, ".git")} -C ${scratch} update-ref -d refs/heads/main`,
  // -C paths accumulate: the second one climbs back into the shared repo
  `git -C ${scratch} -C ${main} gc`,
];

for (const command of ALLOWED) {
  test(`allowed: ${command.replaceAll(root, "<root>")}`, () => {
    const r = bash(command);
    assert.equal(r.status, 0, r.stderr);
  });
}

for (const command of BLOCKED) {
  test(`blocked: ${command.replaceAll(root, "<root>")}`, () => {
    const r = bash(command);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^BLOCKED: git update-ref, gc or prune\./);
    assert.match(r.stderr, /git -C <path>/);
  });
}

for (const command of [`git -C ${scratch} push origin main`, `git -C ${bare} push`, "git push origin main"]) {
  test(`push stays blocked, and says how to test a remote: ${command.replaceAll(root, "<root>")}`, () => {
    const r = bash(command);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^BLOCKED: git push\..*Continue the ticket without it; do not retry\./);
    assert.match(r.stderr, /bare origin.*git fetch/);
  });
}
