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

test("the first ready hook sets the host identity, before the project's setup", () => {
  const [first, second] = hooks();
  assert.match(first.command, /^git config --global user\.name /);
  assert.equal(second.command, "echo setup");
});

test("a sandbox with no agent pass answers git config user.email, and a commit works", () => {
  const home = join(tmp, "home");
  mkdirSync(home);
  const env = { ...clean, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
  const sh = (cmd: string, cwd = home) => execFileSync("sh", ["-c", cmd], { encoding: "utf8", cwd, env }).trim();
  assert.throws(() => sh("git config user.email"), "no identity before the hook");
  sh(hooks()[0].command);
  assert.equal(sh("git config user.email"), "me@example.com");
  assert.equal(sh("git config user.name"), "It's Me");
  const work = join(home, "work");
  sh(`git init -q -b main ${work}`);
  sh("git commit -q --allow-empty -m test", work);
  assert.equal(sh("git log -1 --format=%an", work), "It's Me");
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
