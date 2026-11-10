// What the kit relies on in the installed @ai-hero/sandcastle, read from its `dist` (and its own claudeCode), so a bump
// fails here, by name, where behaviour moved - not as every Claude pass failing at once in a run. Each failure message
// says what changed and what in the kit to look at. Holds Sandcastle 0.14.0; the next releases are known to move the
// command's tail (upstream 7fdca8c6), the ready hooks' exit status (upstream eb8c793b) and a signal-killed command's exit
// (upstream 676c8c5f, 66eb8f1f). No Docker, no model.
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

test("the claude command still ends in ' -p -' (0.14.0); a release that drops it fails here", () => {
  const { command } = claudeCode("claude-sonnet-5-5", { effort: "high", captureSessions: false }).buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true });
  assert.ok(
    command.endsWith(" -p -"),
    `Sandcastle ${pkg.version}'s claude command no longer ends in " -p -" (upstream 7fdca8c6). withTools / withSchema take both shapes; ` +
      `check the prompt still reaches claude on stdin, then make this test hold the new tail. Command: ${command}`,
  );
});

test("the agent provider's env is put on its command as exports (withAgentEnv), outside the kit's own wrapper", () => {
  // 0.14.0 prefixes each agent command with `export KEY='value'; ` for the agent's env (CLAUDE_CODE_DISABLE_AUTO_MEMORY,
  // the auto-compact window); the container's env stays the sandbox's alone. 0.12.0 dropped the agent's env altogether.
  // It wraps the agent the kit hands to `run`, so withTools / withSchema still see a command that starts with "claude ".
  const wrapper = /var withAgentEnv = \(agent, sandboxProviderEnv\) => \{[\s\S]*?\n\};/.exec(index)?.[0] ?? "";
  assert.ok(
    wrapper,
    `Sandcastle ${pkg.version} has no withAgentEnv: check how the agent's env (src/agents.ts's claude()) reaches a pass now, ` +
      `and that withTools / withSchema still see a command that starts with "claude "; then update this test.`,
  );
  assert.match(wrapper, /export \$\{key\}=\$\{shellEscape\(value\)\}; /, `Sandcastle ${pkg.version}: withAgentEnv no longer writes \`export KEY='value'; \` - check test/agent-env.test.ts`);
  assert.match(wrapper, /command: \w+\$?\d* \+ printCommand\.command/, `Sandcastle ${pkg.version}: withAgentEnv no longer puts the exports before the agent's own command`);
  // A key both envs name is refused, so the kit's two lists must stay apart (test/agent-env.test.ts holds that they do).
  assert.match(wrapper, /mergeProviderEnv\(\{[\s\S]*?agentProviderEnv: agent\.env,[\s\S]*?sandboxProviderEnv/, `Sandcastle ${pkg.version}: withAgentEnv no longer checks the agent's env against the sandbox's`);
  assert.match(index, /const provider = withAgentEnv\(runOptions\.agent, ctx\.sandboxProviderEnv\);/, `Sandcastle ${pkg.version}: a sandbox's run no longer wraps the agent in withAgentEnv`);
});

test("a ready hook's exit status is ignored, so the kit's setup hook records its own (setupHook, src/sandbox.ts)", () => {
  // Every place that runs the sandbox ready hooks: from their list to the `Effect.all` that awaits them.
  const blocks = [...index.matchAll(/const sandboxOnReady = hooks\?\.sandbox\?\.onSandboxReady \?\? \[\];[\s\S]*?concurrency: "unbounded"/g)].map((m) => m[0]);
  assert.ok(
    blocks.length > 0,
    `Sandcastle ${pkg.version}: the ready hooks' block in dist/index.js no longer has the shape this test reads - the source ` +
      `moved, which is not yet a change of behaviour. Find where onSandboxReady hooks run (\`grep -n onSandboxReady\` in dist), ` +
      `check they are still run as their command with the exit status ignored (the kit's setupHook, src/sandbox.ts, exits 0 ` +
      `either way), and make this test read the new shape.`,
  );
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

test("an agent's failure reads as agentFailure parses it: 'exited with code N:' or 'reported an error:', the cause on the next line", () => {
  // agentFailure (src/agents.ts) keeps the first line and, after "reported an error:", the next one: the ledger's crashed note.
  for (const shape of [/message: `\$\{provider\.name\} exited with code \$\{execResult\.exitCode\}:\n\$\{errorDetail\}`/, /message: `\$\{provider\.name\} reported an error:\n\$\{streamError\}`/]) {
    assert.match(index, shape, `Sandcastle ${pkg.version}: an AgentError's message no longer has the shape ${shape} - check agentFailure (src/agents.ts) and its tests, then update this test`);
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
