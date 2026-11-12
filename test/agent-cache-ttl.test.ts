// Review and resolve passes run with a 5-minute prompt cache (#852): their longest gap between turns is minutes, so the
// 1-hour cache Claude Code picks on a subscription, whose writes bill at 2x input, never paid for itself. Implement and
// repair keep Claude Code's own choice. The variable is on the pass's command, never in the container's environment:
// Sandcastle refuses a pass whose agent and sandbox name the same key, so a person's `.env` naming it is left out.
// A real `createSandbox(...).run(...)` over a fake bind-mount sandbox, as test/agent-env.test.ts: no Docker, model or network.
//
//   pnpm test:file test/agent-cache-ttl.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AgentProvider, createBindMountSandboxProvider, createSandbox } from "@ai-hero/sandcastle";
import { quietly } from "./quiet.ts";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-cache-ttl-xdg-"));
process.env.XDG_CONFIG_HOME = xdg;
const userEnv = join(xdg, "sandcastle-kit", ".env");
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
const credentialsFile = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n";
writeFileSync(userEnv, credentialsFile);
const { implAgent, resolveAgent, reviewWithFallback } = await import("../src/agents.ts");
const { sandboxEnv } = await import("../src/sandbox.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-cache-ttl-")));
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

/** One pass of `agent` through Sandcastle's own run, in a sandbox whose provider env is `env`; the agent command it got. */
const passCommand = async (agent: AgentProvider, env: Record<string, string> = {}) => {
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
  const sandbox = await createSandbox({ cwd: root, branch: `agent/ttl-${Math.random().toString(36).slice(2, 10)}`, baseBranch: "main", sandbox: provider });
  try {
    await quietly(() => sandbox.run({ agent, prompt: "do it", name: "pass", completionSignal: SIGNAL, logging: { type: "file", path: join(root, ".sandcastle", "logs", "ttl.log") } }));
  } finally {
    await sandbox.close();
  }
  assert.equal(commands.length, 1, "one claude command");
  return commands[0];
};

const TTL = /export CLAUDE_CODE_PROMPT_CACHE_TTL='5m'; /;

test("a review pass's command exports a 5-minute prompt cache", async () => {
  const command = await reviewWithFallback("#1", (agent) => passCommand(agent));
  assert.match(command, TTL);
  assert.match(command, /^export CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'; .*claude /, "the agent's own env stays");
});

test("the review agents' and the resolve agent's env name the 5-minute cache; the implementer's does not", async () => {
  const envs: Record<string, string>[] = [];
  await quietly(() =>
    reviewWithFallback("#1", async (agent) => {
      envs.push(agent.env);
      if (envs.length === 1) throw new Error("claude-code exited with code 1:\nmodel unavailable");
      return "ok";
    }).catch(() => undefined),
  );
  assert.equal(envs.length, 2, "the review model, then its fallback");
  for (const env of envs) assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, "5m");
  assert.equal(resolveAgent().env.CLAUDE_CODE_PROMPT_CACHE_TTL, "5m");
  assert.equal(resolveAgent({ model: "claude-sonnet-5-5", effort: "low" }).env.CLAUDE_CODE_PROMPT_CACHE_TTL, "5m");
  assert.ok(!("CLAUDE_CODE_PROMPT_CACHE_TTL" in implAgent().env));
});

test("the resolve pass's command exports a 5-minute prompt cache, with the implementer's model", async () => {
  const command = await passCommand(resolveAgent({ model: "claude-sonnet-5-5" }));
  assert.match(command, TTL);
  assert.match(command, /--model 'claude-sonnet-5-5'/);
});

test("an implement pass's command leaves the cache TTL to Claude Code", async () => {
  const command = await passCommand(implAgent());
  assert.doesNotMatch(command, /CLAUDE_CODE_PROMPT_CACHE_TTL/);
});

test("a .env naming CLAUDE_CODE_PROMPT_CACHE_TTL stays out of the container, and the review pass is not refused", async () => {
  writeFileSync(userEnv, `${credentialsFile}CLAUDE_CODE_PROMPT_CACHE_TTL=1h\n`);
  try {
    const env = sandboxEnv(project);
    assert.ok(!("CLAUDE_CODE_PROMPT_CACHE_TTL" in env));
    assert.equal(env.GH_TOKEN, "github_pat_fake", "the credentials stay");
    const command = await reviewWithFallback("#1", (agent) => passCommand(agent, env));
    assert.match(command, TTL);
    assert.doesNotMatch(command, /CLAUDE_CODE_PROMPT_CACHE_TTL='1h'/);
  } finally {
    writeFileSync(userEnv, credentialsFile);
  }
});
