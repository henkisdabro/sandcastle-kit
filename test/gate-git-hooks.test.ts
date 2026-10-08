// The git hook probe (src/gates.ts) run as a plain shell snippet in temp
// repos, so no Docker is needed. It is POSIX sh and uses only `mktemp`, `sed`
// and git 2.36+'s `git hook run`, which behave alike on macOS and Linux.
//
//   pnpm test:file test/gate-git-hooks.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { GIT_HOOK_PROBE, gitHooksLine, parseGitHookProbe } = await import("../src/gates.ts");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "git-hooks-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
};

// Hooks live in `.githooks` and core.hooksPath points there, as a project's do.
const hook = (dir: string, name: string, body: string) => {
  mkdirSync(join(dir, ".githooks"), { recursive: true });
  const file = join(dir, ".githooks", name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  git(dir, "config", "core.hooksPath", ".githooks");
};

const probe = (dir: string) =>
  parseGitHookProbe(execFileSync("sh", ["-c", GIT_HOOK_PROBE], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

const NEEDS = `command -v sandcastle-test-scanner >/dev/null || { echo "sandcastle-test-scanner: command not found"; exit 1; }`;

test("a core.hooksPath pre-commit that needs a missing command is refused, with its output", () => {
  const dir = repo();
  hook(dir, "pre-commit", NEEDS);
  const r = probe(dir);
  assert.equal(r.failure?.name, "pre-commit");
  assert.match(r.failure!.output, /sandcastle-test-scanner: command not found/);
  assert.deepEqual(r.hooks, [{ name: "pre-commit", status: "fail" }]);
});

test("the same hook passes when the command is on PATH", () => {
  const dir = repo();
  const bin = mkdtempSync(join(tmpdir(), "git-hooks-bin-"));
  writeFileSync(join(bin, "sandcastle-test-scanner"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "sandcastle-test-scanner"), 0o755);
  hook(dir, "pre-commit", NEEDS);
  const out = execFileSync("sh", ["-c", GIT_HOOK_PROBE], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const r = parseGitHookProbe(out);
  assert.equal(r.failure, undefined);
  assert.equal(gitHooksLine(r), "git hooks: pre-commit=pass commit-msg=none");
});

test("a commit-msg hook that rejects the message is refused", () => {
  const dir = repo();
  hook(dir, "commit-msg", `echo "subject must say ticket: $(cat "$1")" >&2; exit 1`);
  const r = probe(dir);
  assert.equal(r.failure?.name, "commit-msg");
  assert.match(r.failure!.output, /subject must say ticket: chore: /);
  assert.deepEqual(r.hooks.map((h) => `${h.name}=${h.status}`), ["pre-commit=none", "commit-msg=fail"]);
});

test("no hooks at all reads as none", () => {
  const r = probe(repo());
  assert.equal(r.failure, undefined);
  assert.equal(gitHooksLine(r), "git hooks: pre-commit=none commit-msg=none");
});

test("a hook in .git/hooks is found without a core.hooksPath", () => {
  const dir = repo();
  const file = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  assert.equal(gitHooksLine(probe(dir)), "git hooks: pre-commit=pass commit-msg=none");
});

test("the probe leaves the status and every ref unchanged", () => {
  const dir = repo();
  hook(dir, "pre-commit", "exit 0");
  hook(dir, "commit-msg", "exit 0");
  const state = () => [git(dir, "status", "--porcelain"), git(dir, "for-each-ref"), git(dir, "rev-parse", "HEAD"), git(dir, "stash", "list")].join("\n--\n");
  const before = state();
  const r = probe(dir);
  assert.equal(gitHooksLine(r), "git hooks: pre-commit=pass commit-msg=pass");
  assert.equal(state(), before);
});

test("an image whose git has no `git hook run` is reported, not failed", () => {
  const r = parseGitHookProbe("@@unsupported git version 2.30.2\n");
  assert.equal(r.failure, undefined);
  assert.equal(gitHooksLine(r), "git hooks: not checked (git 2.30.2 in the image has no `git hook run`)");
});

test("the probe stops at git older than 2.36", () => {
  const dir = repo();
  const bin = mkdtempSync(join(tmpdir(), "git-hooks-oldgit-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = --version ] && { echo "git version 2.30.2"; exit 0; }\nexit 99\n`);
  chmodSync(join(bin, "git"), 0o755);
  const out = execFileSync("sh", ["-c", GIT_HOOK_PROBE], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(gitHooksLine(parseGitHookProbe(out)), "git hooks: not checked (git 2.30.2 in the image has no `git hook run`)");
});
