// What the kit relies on in the installed @ai-hero/sandcastle, read from its `dist` (and its own claudeCode), so a bump
// fails here, by name, where behaviour moved - not as every Claude pass failing at once in a run. Each failure message
// says what changed and what in the kit to look at. Holds Sandcastle 0.12.0 (the version this was written on); the
// next releases are known to move the agent env (0.14.0's `withAgentEnv`), the command's tail (after 0.14.0, upstream
// 7fdca8c6), the ready hooks' exit status (upstream eb8c793b) and a signal-killed command's exit (upstream 676c8c5f,
// 66eb8f1f). No Docker, no model.
//
//   pnpm test:file test/sandcastle-contract.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeCode } from "@ai-hero/sandcastle";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { withSchema, withTools } = await import("../src/agents.ts");

// The installed package's dist, every module of it: chunk names are content hashes and move between releases.
const dist = dirname(fileURLToPath(import.meta.resolve("@ai-hero/sandcastle")));
const pkg = JSON.parse(readFileSync(join(dist, "../package.json"), "utf8")) as { version: string };
const modules = [...readdirSync(dist), ...readdirSync(join(dist, "sandboxes")).map((f) => `sandboxes/${f}`)]
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ file: f, text: readFileSync(join(dist, f), "utf8") }));
const all = modules.map((m) => m.text).join("\n");
const index = readFileSync(join(dist, "index.js"), "utf8");
// The docker sandbox's own module: `sandboxes/docker.js` re-exports it from a chunk.
const dockerChunk = (() => {
  const from = /export \{ docker \} from '\.\.\/([^']+)'/.exec(readFileSync(join(dist, "sandboxes/docker.js"), "utf8"))?.[1];
  assert.ok(from, `Sandcastle ${pkg.version}: sandboxes/docker.js no longer re-exports docker from a chunk - update dockerChunk in this test`);
  return readFileSync(join(dist, from), "utf8");
})();

test("the claude command carries --output-format stream-json, where withTools and withSchema put their flags", () => {
  const { command } = claudeCode("claude-sonnet-5-5", { effort: "high", captureSessions: false }).buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true });
  // The real command takes both flags; a shape they refuse fails every Claude pass, so it fails here first.
  assert.doesNotThrow(() => withSchema(withTools(command, ["Bash"]), "{}"), `Sandcastle ${pkg.version}: withTools / withSchema (src/agents.ts) refuse its claude command: ${command}`);
  assert.match(command, /^claude .* --output-format stream-json /);
});

test("the claude command still ends in ' -p -' (0.12.0); a release that drops it fails here", () => {
  const { command } = claudeCode("claude-sonnet-5-5", { effort: "high", captureSessions: false }).buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true });
  assert.ok(
    command.endsWith(" -p -"),
    `Sandcastle ${pkg.version}'s claude command no longer ends in " -p -" (upstream 7fdca8c6). withTools / withSchema take both shapes; ` +
      `check the prompt still reaches claude on stdin, then make this test hold the new tail. Command: ${command}`,
  );
});

test("the agent provider's env is merged into the sandbox's env, with no per-command wrapper (no withAgentEnv)", () => {
  // 0.12.0: `mergeProviderEnv` puts the agent's env (CLAUDE_CODE_DISABLE_AUTO_MEMORY, the auto-compact window) beside the
  // sandbox's for the whole container, and refuses a key both name. 0.14.0 wraps the agent's command instead.
  assert.ok(
    !/withAgentEnv/.test(all),
    `Sandcastle ${pkg.version} has withAgentEnv: the agent's env is now put on its command, not on the container. ` +
      `Check that src/agents.ts's claude() env still reaches each pass, that withTools / withSchema still see a command ` +
      `that starts with "claude " (or move them past the wrapper), and that sandboxEnv's keys (src/sandbox.ts) need no change; then update this test.`,
  );
  assert.match(index, /agentProviderEnv: provider\.env/, `Sandcastle ${pkg.version}: the agent's env is no longer passed as agentProviderEnv - see the withAgentEnv message in this test`);
});

test("a ready hook's exit status is ignored, so the kit's setup hook records its own (setupHook, src/sandbox.ts)", () => {
  // Every place that runs the sandbox ready hooks: from their list to the `Effect.all` that awaits them.
  const blocks = [...index.matchAll(/const sandboxOnReady = options\.hooks\?\.sandbox\?\.onSandboxReady;[\s\S]*?concurrency: "unbounded"/g)].map((m) => m[0]);
  assert.ok(blocks.length > 0, `Sandcastle ${pkg.version}: no onSandboxReady block found in dist/index.js - find where ready hooks run and update this test`);
  for (const block of blocks) {
    assert.match(block, /sandbox\d?\.exec\(hook\.command,/, `Sandcastle ${pkg.version}: a ready hook is no longer run as its command - check setupHook (src/sandbox.ts)`);
    assert.ok(
      !/exitCode/.test(block),
      `Sandcastle ${pkg.version} now reads a ready hook's exit status (upstream eb8c793b: a non-zero one rejects createSandbox). ` +
        `The kit's setup hook always exits 0 and the kit reads its record (setupHook, assertSetup, setupFailure in src/sandbox.ts), ` +
        `so the outcome stays the kit's; check the kit's other ready hooks (git identity, Codex auth) exit 0, then update this test.`,
    );
  }
});

test("the docker sandbox's exec reports a command killed by a signal as exit 0 (`code ?? 0`)", () => {
  const exits = [...dockerChunk.matchAll(/exitCode: code \?\? 0/g)].length;
  assert.ok(
    exits > 0 && !/__SANDCASTLE_EXIT_STATUS/.test(all),
    `Sandcastle ${pkg.version} changed how exec reports a command with no exit code (upstream 676c8c5f, 66eb8f1f: a signal is a ` +
      `failure, and every command runs in a subshell that prints __SANDCASTLE_EXIT_STATUS=<n> as its last stderr line). ` +
      `Check what reads exec's stderr or exit status: gate output and timeouts (execGate, src/worktree-lock.ts; failingTests, src/gates.ts), ` +
      `the git-hook probe and the setup record (src/gates.ts, src/sandbox.ts); then update this test.`,
  );
});
