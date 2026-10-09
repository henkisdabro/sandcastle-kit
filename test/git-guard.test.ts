// The managed Claude Code hook that guards the shared .git (container/git-guard.sh): hook JSON
// piped into the script in a temp repo with a linked worktree, and the read-only mount of
// container/ at /etc/claude-code. bash and jq are the same requirements the image has.
//
//   pnpm test:file test/git-guard.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";
import { KIT, MANAGED_SETTINGS, sandboxMounts } from "../src/sandbox.ts";

const GUARD = join(KIT, "container/git-guard.sh");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-git-guard-")));
const main = join(root, "main");
const worktree = join(root, "agent-1");
const sibling = join(root, "agent-2");
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(main);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", main, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
git("init", "-q", "-b", "main");
git("commit", "-q", "--allow-empty", "-m", "start");
git("worktree", "add", "-q", "-b", "agent/issue-1", worktree);
git("worktree", "add", "-q", "-b", "agent/issue-2", sibling);
const shared = join(main, ".git");
mkdirSync(join(worktree, "node_modules/p/.git"), { recursive: true });

// What Claude Code pipes to a PreToolUse hook; the agent's cwd is its own worktree.
const run = (tool_input: Record<string, string>, cwd = worktree) =>
  spawnSync("bash", [GUARD], { input: JSON.stringify({ cwd, tool_input }), encoding: "utf8", env });
const bash = (command: string) => run({ command });
const write = (file_path: string) => run({ file_path });

const BLOCKED = [
  "git update-ref -d refs/heads/agent/issue-3",
  "git -C . update-ref -d refs/heads/main",
  "cd x && git gc --prune=now",
  "git reflog expire --expire=now --all",
  "git worktree repair",
  "git worktree prune",
  "git worktree add ../x",
  "git branch -D agent/issue-3",
  "git branch -f agent/issue-1 HEAD",
  "git branch --delete --force agent/issue-1",
  "git push origin main",
  "sudo git push",
  "echo x; git prune",
  // a variable assignment before git does not hide it
  "FOO=1 git push origin main",
  "GIT_TRACE=1 git update-ref -d refs/heads/main",
  `rm -rf ${shared}/worktrees/agent-2`,
  // refs/stash is in the shared .git: a pop can apply another agent's change
  "git stash",
  "git stash pop -q",
  "git stash push src/a.ts -q && pnpm test; git stash pop -q",
  "git stash -q -- src/herdr.ts",
  "git stash drop",
];

const ALLOWED = [
  'git commit -m "tidy gc and prune handling"',
  'git commit -m "docs: git push guidance"',
  "git log --oneline | head",
  "git worktree remove --force /tmp/x",
  "git branch -D scratch-tmp",
  'git branch --list "agent/*"',
  "git reset --hard",
  "git clean -fd",
  "git checkout .",
  "git merge --no-edit main",
  "git stash list",
  "git stash show -p",
  "rm -rf node_modules/pkg/.git/",
  "rm -rf dist",
  "git status --porcelain",
  "pnpm test",
];

for (const command of BLOCKED) {
  test(`blocked: ${command}`, () => {
    const r = bash(command);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^BLOCKED: .*Continue the ticket without it; do not retry\./);
  });
}

for (const command of ALLOWED) {
  test(`allowed: ${command}`, () => {
    const r = bash(command);
    assert.equal(r.status, 0, r.stderr);
  });
}

for (const file of [join(shared, "hooks/post-merge"), join(shared, "config")]) {
  test(`blocked: write to ${file.slice(root.length)}`, () => {
    assert.equal(write(file).status, 2);
    assert.equal(run({ file_path: file }, main).status, 2);
  });
}

for (const [what, file] of [
  ["the worktree", join(worktree, "src/a.ts")],
  ["a sibling worktree", join(sibling, "src/a.ts")],
  ["a package's own .git", join(worktree, "node_modules/p/.git/config")],
]) {
  test(`allowed: write to ${what}`, () => assert.equal(write(file).status, 0));
}

test("a hook call with no command and no file is let through", () => {
  assert.equal(run({}).status, 0);
});

test("container/ is mounted read-only at /etc/claude-code, beside the project's own mounts", () => {
  const own = { hostPath: "/store", sandboxPath: "/home/agent/.store" };
  const mounts = sandboxMounts({ mounts: [own] } as Project);
  assert.deepEqual(mounts.find((m) => m.sandboxPath === MANAGED_SETTINGS), { hostPath: join(KIT, "container"), sandboxPath: "/etc/claude-code", readonly: true });
  assert.ok(mounts.includes(own));
});

test("sandboxConfig takes its mounts from sandboxMounts", () => {
  assert.match(readFileSync(join(KIT, "src/sandbox.ts"), "utf8"), /mounts: sandboxMounts\(project\)/);
});

test("the managed settings run the mounted guard on Bash, Write and Edit, and leave project hooks on", () => {
  const settings = JSON.parse(readFileSync(join(KIT, "container/managed-settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: "Bash|Write|Edit", hooks: [{ type: "command", command: `${MANAGED_SETTINGS}/git-guard.sh` }] }]);
  assert.equal(settings.allowManagedHooksOnly, undefined);
});

test("git-guard.sh is valid bash", () => {
  execFileSync("bash", ["-n", GUARD]);
});
