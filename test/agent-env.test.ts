// The Claude agent's env reaches every sandboxed pass. On Sandcastle 0.12.0 it never did: the container started with
// no agent env and the print command ran with none, so auto memory stayed on and `autoCompactWindow` did nothing.
// 0.14.0 puts it on the command as `export KEY='value'; ` and refuses a key the sandbox's own env also names, so the
// two must stay apart, even when the person's `.env` sets one of the agent's keys. A real `createSandbox(...).run(...)`
// over a fake bind-mount sandbox: no Docker, model or network.
//
//   pnpm test:file test/agent-env.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBindMountSandboxProvider, createSandbox } from "@ai-hero/sandcastle";
import { quietly } from "./quiet.ts";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-agent-env-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;
const userEnv = join(xdg, "sandcastle-kit", ".env");
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
const credentialsFile = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n";
writeFileSync(userEnv, credentialsFile);
const { claudeEnv, configureAutoCompact, implAgent } = await import("../src/agents.ts");
const { sandboxEnv } = await import("../src/sandbox.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-agent-env-")));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
writeFileSync(join(root, "tracked.txt"), "tracked\n");
git("add", "-A");
git("commit", "-q", "-m", "start");
mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
const project = { root, tracker: fakeTracker() } as unknown as Project;

const SIGNAL = "<promise>COMPLETE</promise>";
const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `done\n\n${SIGNAL}`, session_id: "s" });

/** One Claude pass through Sandcastle's own run, in a sandbox whose provider env is `env`; the agent command it got. */
const passCommand = async (env: Record<string, string>) => {
  const commands: string[] = [];
  const provider = createBindMountSandboxProvider({
    name: "fake",
    env,
    create: async ({ worktreePath }) => ({
      worktreePath,
      exec: async (command, options) => {
        if (!/claude /.test(command)) return { stdout: "", stderr: "", exitCode: 0 };
        commands.push(command);
        options?.onLine?.(result);
        return { stdout: `${result}\n`, stderr: "", exitCode: 0 };
      },
      copyFileIn: async () => {},
      copyFileOut: async () => {},
      close: async () => {},
    }),
  });
  const sandbox = await createSandbox({ cwd: root, branch: `agent/env-${Math.random().toString(36).slice(2, 10)}`, baseBranch: "main", sandbox: provider });
  try {
    await quietly(() =>
      sandbox.run({ agent: implAgent(), prompt: "do it", name: "implement", completionSignal: SIGNAL, logging: { type: "file", path: join(root, ".sandcastle", "logs", "env.log") } }),
    );
  } finally {
    await sandbox.close();
  }
  return commands;
};

test("a pass's command exports the agent's env: auto memory off, and the auto-compact window when set", async () => {
  configureAutoCompact(undefined);
  const [plain] = await passCommand({});
  assert.match(plain, /^export CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'; claude /);
  assert.doesNotMatch(plain, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  configureAutoCompact(300_000);
  try {
    const [windowed] = await passCommand({});
    assert.match(windowed, /^export CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'; export CLAUDE_CODE_AUTO_COMPACT_WINDOW='300000'; claude /);
  } finally {
    configureAutoCompact(undefined);
  }
});

test("the sandbox's env and the agent's share no key, so Sandcastle never refuses a pass", async () => {
  configureAutoCompact(300_000);
  try {
    writeFileSync(userEnv, credentialsFile);
    const env = sandboxEnv(project);
    assert.deepEqual(Object.keys(claudeEnv()).filter((k) => k in env), []);
    // The person's own .env naming the agent's keys: left out of the container's, where they would clash.
    writeFileSync(userEnv, `${credentialsFile}CLAUDE_CODE_DISABLE_AUTO_MEMORY=0\nCLAUDE_CODE_AUTO_COMPACT_WINDOW=200000\n`);
    const theirs = sandboxEnv(project);
    assert.deepEqual(Object.keys(claudeEnv()).filter((k) => k in theirs), []);
    assert.equal(theirs.GH_TOKEN, "github_pat_fake", "the credentials stay");
    const [command] = await passCommand(theirs);
    assert.match(command, /^export CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'; export CLAUDE_CODE_AUTO_COMPACT_WINDOW='300000'; claude /);
  } finally {
    configureAutoCompact(undefined);
    writeFileSync(userEnv, credentialsFile);
  }
});

test("a key the agent's env does not set stays the person's: the window from .env when the project sets none", () => {
  configureAutoCompact(undefined);
  writeFileSync(userEnv, `${credentialsFile}CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000\n`);
  try {
    assert.equal(sandboxEnv(project).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  } finally {
    writeFileSync(userEnv, credentialsFile);
  }
});
