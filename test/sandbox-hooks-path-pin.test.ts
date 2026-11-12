// Every sandbox is given the project's tracked hooks path through its git environment (a `GIT_CONFIG_*` pair), so a
// worktree tool that rewrites the shared `.git/config` value to its absolute host form (which does not exist in a
// container) leaves agent commits running the repo's hooks. The kit writes nothing to `.git/config`. Doctor and the
// base check say what is true: a warning for that exact form, a FIX for an untracked directory. Temp repos only; no Docker.
//
//   pnpm test:file test/sandbox-hooks-path-pin.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
writeFileSync(join(xdg, "sandcastle-kit", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n");
const { sandboxEnv } = await import("../src/sandbox.ts");
const { hooksPathLines } = await import("../src/lean.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const repo = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-hooks-pin-")));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".githooks"));
  writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(join(root, "untracked-dir"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle", "config.ts"), 'export default { name: "t", tracker: "files", setup: [], gates: [{ name: "ok", command: "true" }] };\n');
  git("add", "--", ".githooks", ".sandcastle");
  git("commit", "-q", "-m", "start");
  return { root, git, project: { root, tracker: fakeTracker() } as unknown as Project };
};

/** The `[key, value]` pairs git would read from an environment, as git reads them. */
const pairs = (env: Record<string, string>) =>
  Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);

const hooksPair = (env: Record<string, string>) => pairs(env).filter(([k]) => k === "core.hooksPath");

test("a sandbox is given the relative tracked hooks path, while the config holds it and after it is rewritten absolute", () => {
  const { root, git, project } = repo();
  git("config", "core.hooksPath", ".githooks");
  assert.deepEqual(hooksPair(sandboxEnv(project)), [["core.hooksPath", ".githooks"]]);
  git("config", "core.hooksPath", join(root, ".githooks"));
  const env = sandboxEnv(project);
  assert.deepEqual(hooksPair(env), [["core.hooksPath", ".githooks"]]);
  assert.deepEqual(pairs(env).slice(0, 2), [["gc.auto", "0"], ["maintenance.auto", "false"]], "beside the maintenance pairs");
});

test("git, given that environment, reads the relative path even where the config holds the absolute one", () => {
  const { root, git, project } = repo();
  git("config", "core.hooksPath", join(root, "gone", "hooks"));
  git("config", "core.hooksPath", join(root, ".githooks"));
  const env = Object.fromEntries(Object.entries(sandboxEnv(project)).filter(([k]) => k.startsWith("GIT_CONFIG_")));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG"))) as Record<string, string>;
  const read = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8", env: { ...clean, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env } }).trim();
  assert.equal(read, ".githooks");
});

test("no hooks path pair is added for no value, a path outside the project, or an untracked directory", () => {
  const { root, git, project } = repo();
  assert.deepEqual(hooksPair(sandboxEnv(project)), []);
  git("config", "core.hooksPath", "/home/user/elsewhere/hooks");
  assert.deepEqual(hooksPair(sandboxEnv(project)), []);
  git("config", "core.hooksPath", "../hooks");
  assert.deepEqual(hooksPair(sandboxEnv(project)), []);
  git("config", "core.hooksPath", "untracked-dir");
  assert.deepEqual(hooksPair(sandboxEnv(project)), []);
  git("config", "core.hooksPath", join(root, "untracked-dir"));
  assert.deepEqual(hooksPair(sandboxEnv(project)), []);
});

test("the lines for the project's own absolute tracked path say sandboxes are given it; an untracked directory keeps the old words", () => {
  const { root } = repo();
  const tracked = hooksPathLines(join(root, ".githooks"), root).join("\n");
  assert.doesNotMatch(tracked, /agent commits run none/);
  assert.match(tracked, /Sandboxes are given `\.githooks` through their environment, so agent commits still run its hooks/);
  assert.match(tracked, /git config core\.hooksPath \.githooks/);
  const untracked = hooksPathLines(join(root, "untracked-dir"), root).join("\n");
  assert.match(untracked, /agent commits run none/);
  assert.match(untracked, /git config core\.hooksPath untracked-dir/);
});

test("doctor warns for the exact absolute form of a tracked directory and keeps the FIX for an untracked one", () => {
  const doctor = (value: string) => {
    const { root, git } = repo();
    git("config", "core.hooksPath", value.replace("<root>", root));
    return runKit(["doctor"], { cwd: root, encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-test-")), GIT_CEILING_DIRECTORIES: tmpdir() } }).stdout;
  };
  const tracked = doctor("<root>/.githooks");
  assert.match(tracked, /warn core\.hooksPath is ".*\.githooks", the absolute form of this project's own `\.githooks`/);
  assert.doesNotMatch(tracked, /FIX  core\.hooksPath/);
  const untracked = doctor("<root>/untracked-dir");
  assert.match(untracked, /FIX  core\.hooksPath is ".*untracked-dir".*agent commits run none/);
});
