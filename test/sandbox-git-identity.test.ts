// Every sandbox the kit creates has a git identity before any gate runs: Sandcastle sets one only
// while an agent runs, so the landing sandbox, the base gates and a requeue's gates-only re-run
// had none, and a test that commits passed on its branch and failed at landing. The fix is in
// `sandboxConfig`'s ready hook, which every sandbox goes through; there is no Docker here, so the
// test runs the hook's command in a clean HOME instead of a real sandbox.
//
//   pnpm exec tsx --test test/sandbox-git-identity.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";

// Before the kit's modules load: they read XDG_CONFIG_HOME once, for the credentials file.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { fakeTracker } = await import("./fixtures.ts");
const { hostIdentity, hostIdentityParts } = await import("../src/generated.ts");
const { AGENT_COMMITTER, sandboxConfig } = await import("../src/sandbox.ts");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-git-identity-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));
const repo = join(tmp, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main", repo]);
execFileSync("git", ["-C", repo, "config", "user.name", "It's Me"]);
execFileSync("git", ["-C", repo, "config", "user.email", "me@example.com"]);

mkdirSync(join(repo, ".sandcastle"));
writeFileSync(join(repo, ".sandcastle/.env"), "ANTHROPIC_API_KEY=made-up\n");

const project = { root: repo, setup: ["echo setup"], mounts: [], generated: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
const hooks = () => sandboxConfig(project, "image", "plan.json").hooks.sandbox.onSandboxReady;

test("a ready hook sets the host identity, beside the project's setup", () => {
  const [first, second] = hooks();
  assert.match(first.command, /git config --file .* user\.name /);
  assert.equal(second.command, "(echo setup\n)");
});

test("setup's steps run in order, in one hook: Sandcastle runs its ready hooks at once", () => {
  const steps = ["echo one # first", "echo two"];
  const all = sandboxConfig({ ...project, setup: steps } as Project, "image", "plan.json").hooks.sandbox.onSandboxReady;
  assert.equal(all.length, 2);
  assert.equal(execFileSync("sh", ["-c", all[1].command], { encoding: "utf8" }), "one\ntwo\n");
});

// A clean HOME, as a fresh sandbox has: no ~/.gitconfig and no XDG git config.
const sandboxHome = (name: string) => {
  const home = join(tmp, name);
  mkdirSync(home);
  const env = { ...clean, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
  const sh = (cmd: string, cwd = home) => execFileSync("sh", ["-c", cmd], { encoding: "utf8", cwd, env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { home, sh };
};

test("a sandbox with no agent pass answers git config user.email, and a commit works", () => {
  const { home, sh } = sandboxHome("home");
  assert.throws(() => sh("git config user.email"), "no identity before the hook");
  sh(hooks()[0].command);
  assert.equal(sh("git config user.email"), "me@example.com");
  assert.equal(sh("git config user.name"), "It's Me");
  const work = join(home, "work");
  sh(`git init -q -b main ${work}`);
  sh("git commit -q --allow-empty -m test", work);
  assert.equal(sh("git log -1 --format=%an", work), "It's Me");
});

// Sandcastle runs the ready hooks all at once: a setup step writing `git config --global` holds
// ~/.gitconfig.lock while this hook runs, and the hook must neither fail on it nor make it fail.
test("the identity hook needs no lock on ~/.gitconfig, and a setup step's identity still wins", () => {
  const { home, sh } = sandboxHome("home-race");
  // Sandcastle writes safe.directory to ~/.gitconfig before any hook runs. Without the file, the
  // setup step's `--global` would write to the XDG file and pass without ~/.gitconfig winning.
  writeFileSync(join(home, ".gitconfig"), "");
  writeFileSync(join(home, ".gitconfig.lock"), "");
  sh(hooks()[0].command);
  assert.equal(sh("git config user.email"), "me@example.com");
  rmSync(join(home, ".gitconfig.lock"));
  sh("git config --global user.email setup@example.com");
  assert.equal(sh("git config user.email"), "setup@example.com");
});

test("the committer stays the agent: the identity is global config, not GIT_AUTHOR_* in the environment", () => {
  assert.equal(AGENT_COMMITTER.GIT_COMMITTER_NAME, "Sandcastle agent");
  const env = sandboxConfig(project, "image", "plan.json").sandbox as unknown as { env?: Record<string, string> };
  assert.ok(!JSON.stringify(env).includes("GIT_AUTHOR"));
});

test("hostIdentity and hostIdentityParts agree", () => {
  assert.deepEqual(hostIdentityParts(repo), { name: "It's Me", email: "me@example.com" });
  assert.equal(hostIdentity(repo), `-c user.name='It'\\''s Me' -c user.email='me@example.com'`);
});
