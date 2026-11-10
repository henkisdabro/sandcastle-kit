// Commit hooks the host has that the sandbox's git-hook probe finds none of: from Sandcastle 0.13.0 a sandbox cannot
// write its .git/config or .git/hooks, so husky in `setup` installs nothing (and exits 0) and agent commits run no
// hooks with nothing red. The kit copies no hooks in; the base check prints a WARNING naming the cause and the fix
// (`hooksMissingWarning`, src/gates.ts; `hostHooks`, src/lean.ts). Temp repos only; no Docker.
//
//   pnpm test:file test/hooks-missing-in-sandbox.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The kit's config dir is read at import; a test must not touch the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { hooksMissingWarning } = await import("../src/gates.ts");
const { disableHostGitHooks } = await import("../src/guard.ts");

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hooks-missing-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  return { root, git };
};
const hook = (dir: string, name: string, mode = 0o755) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode });
};
const none = { hooks: [{ name: "pre-commit", status: "none" as const }, { name: "commit-msg", status: "none" as const }] };

test("husky's hooks on the host and none in the sandbox: a WARNING with the cause and the fix", () => {
  const { root, git } = repo();
  // What husky 9 leaves on the host: core.hooksPath=.husky/_ (gitignored), its wrappers executable.
  git("config", "core.hooksPath", ".husky/_");
  hook(join(root, ".husky/_"), "pre-commit");
  hook(join(root, ".husky/_"), "commit-msg");
  const lines = hooksMissingWarning(root, none);
  assert.match(lines[0], /^ {2}WARNING: git hooks pre-commit, commit-msg run on the host but not in the sandbox/);
  assert.match(lines.join("\n"), /cannot write its \.git\/config or \.git\/hooks.*husky/s);
  assert.match(lines.join("\n"), /-> Install the hooks on the host only.*drop the installer from `setup`/s);
});

test("hooks installed in .git/hooks count, read past the kit's own core.hooksPath=/dev/null", () => {
  const { root } = repo();
  hook(join(root, ".git/hooks"), "pre-commit");
  const saved = { ...process.env };
  try {
    disableHostGitHooks();
    assert.match(hooksMissingWarning(root, none)[0], /WARNING: git hook pre-commit runs on the host/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("no warning when the sandbox runs the hooks, when the host has none, or for git's samples", () => {
  const { root, git } = repo();
  git("config", "core.hooksPath", ".githooks");
  hook(join(root, ".githooks"), "pre-commit");
  assert.deepEqual(hooksMissingWarning(root, { hooks: [{ name: "pre-commit", status: "pass" }, { name: "commit-msg", status: "none" }] }), []);
  const bare = repo();
  hook(join(bare.root, ".git/hooks"), "pre-commit.sample");
  hook(join(bare.root, ".git/hooks"), "commit-msg", 0o644);
  assert.deepEqual(hooksMissingWarning(bare.root, none), []);
  assert.deepEqual(hooksMissingWarning(root, { hooks: [], unchecked: "git 2.30 in the image has no `git hook run`" }), []);
});

test("a core.hooksPath outside the project is left to its own warning", () => {
  const { root, git } = repo();
  const outside = mkdtempSync(join(tmpdir(), "sandcastle-hooks-outside-"));
  hook(outside, "pre-commit");
  git("config", "core.hooksPath", outside);
  assert.deepEqual(hooksMissingWarning(root, none), []);
});
