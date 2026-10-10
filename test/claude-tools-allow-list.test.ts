// A sandbox pass loads only the built-in tools it uses (`--tools`) and runs with auto memory off: the tool
// schemas are fixed prompt prefix paid on every turn. The pass's command is checked against the one
// Sandcastle's own claudeCode builds, so a Sandcastle update that changes its shape fails here. No Docker.
//
//   pnpm test:file test/claude-tools-allow-list.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCode } from "@ai-hero/sandcastle";

// Before the kit's modules load: they read these once.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-tools-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const { BASE_TOOLS, configureTools, implAgent, toolsFor, withTools } = await import("../src/agents.ts");
const { loadProject } = await import("../src/config.ts");

const BASE = "Bash,Read,Edit,Write,TaskStop";
const built = (resumeSession?: string) =>
  claudeCode("claude-sonnet-5-5", { effort: "high", captureSessions: false }).buildPrintCommand({
    prompt: "x",
    dangerouslySkipPermissions: true,
    resumeSession,
  });
const toolsOf = (command: string) => command.match(/ --tools '([^']*)'/)?.[1];

test("a pass with nothing kept loads Bash, Read, Edit, Write and TaskStop", () => {
  assert.deepEqual(BASE_TOOLS, ["Bash", "Read", "Edit", "Write", "TaskStop"]);
  assert.deepEqual(toolsFor([]), ["Bash", "Read", "Edit", "Write", "TaskStop"]);
});

test("a kept skill or command adds Skill, a kept MCP server adds ToolSearch, each once", () => {
  assert.deepEqual(toolsFor(["skill:verify"]), [...BASE_TOOLS, "Skill"]);
  assert.deepEqual(toolsFor(["command:deploy"]), [...BASE_TOOLS, "Skill"]);
  assert.deepEqual(toolsFor(["mcp:docs"]), [...BASE_TOOLS, "ToolSearch"]);
  assert.deepEqual(toolsFor(["mcp:a", "skill:b", "command:c", "mcp:d", "skill:e"]), [...BASE_TOOLS, "Skill", "ToolSearch"]);
});

test("a kept agent or Codex skill adds no tool", () => {
  assert.deepEqual(toolsFor(["agent:reviewer", "codex-skill:verify"]), BASE_TOOLS);
});

test("--tools goes just before the closing -p - and nothing else changes", () => {
  for (const resume of [undefined, "session-1"]) {
    const { command } = built(resume);
    const out = withTools(command, BASE_TOOLS);
    assert.equal(out, `${command.slice(0, -" -p -".length)} --tools '${BASE}' -p -`);
    assert.ok(out.endsWith(` --tools '${BASE}' -p -`));
    assert.equal(out.replace(` --tools '${BASE}'`, ""), command);
  }
  assert.match(withTools(built("session-1").command, BASE_TOOLS), /--resume 'session-1' --tools /);
});

test("a claude command of another shape is refused", () => {
  assert.throws(() => withTools("claude --print --model m", BASE_TOOLS), /no longer has the shape.*src\/agents\.ts/);
  assert.throws(() => withTools("codex exec -p -", BASE_TOOLS), /no longer has the shape.*src\/agents\.ts/);
});

test("the implementer's pass runs with the allow-list and auto memory off", () => {
  configureTools();
  const agent = implAgent();
  const printed = agent.buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true });
  assert.equal(toolsOf(printed.command), BASE);
  assert.ok(printed.command.endsWith(" -p -"));
  assert.equal(printed.stdin, "x");
  assert.equal(agent.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  configureTools(["skill:verify"]);
  assert.equal(toolsOf(implAgent().buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true }).command), `${BASE},Skill`);
  configureTools();
});

test("a project that keeps an MCP server loads ToolSearch in every pass", async () => {
  const root = join(dir, "project");
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "true" }], lean: { keep: ["mcp:docs"] } };\n`);
  try {
    await loadProject(root);
    assert.equal(toolsOf(implAgent().buildPrintCommand({ prompt: "x", dangerouslySkipPermissions: true }).command), `${BASE},ToolSearch`);
  } finally {
    configureTools();
  }
});
