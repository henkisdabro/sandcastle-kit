// `lean.keep` takes `tool:<Name>` to give sandbox passes another built-in Claude Code tool. The name is
// checked when the config loads (Claude Code ignores an unknown `--tools` name without a word), reaches the
// pass's tool list, and is not reported by the lean check as a repo file that is missing. No Docker.
//
//   pnpm test:file test/lean-keep-tool.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Before the kit's modules load: they read these once.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-keep-tool-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const { BASE_TOOLS, configureTools, toolsFor } = await import("../src/agents.ts");
const { CLAUDE_CODE_TOOLS, managedDenied } = await import("../src/claude-tools.ts");
const { loadProject } = await import("../src/config.ts");
const { plan, unmatched } = await import("../src/lean.ts");

let n = 0;
const projectWith = (keep: string[]) => {
  const root = join(dir, `project-${n++}`);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "true" }], lean: { keep: ${JSON.stringify(keep)} } };\n`);
  return root;
};

test("a denied tool in lean.keep is refused, naming the deny", async () => {
  await assert.rejects(loadProject(projectWith(["tool:Monitor"])), /tool:Monitor.*managed settings deny Monitor in every sandbox/);
});

test("a misspelt tool in lean.keep is refused, naming the nearest tool", async () => {
  await assert.rejects(loadProject(projectWith(["tool:WebSerch"])), /tool:WebSerch.*ignore it silently.*did you mean `tool:WebSearch`\?/);
  await assert.rejects(loadProject(projectWith(["tool:websearch2"])), /did you mean `tool:WebSearch`\?/);
});

test("known, not-denied tools in lean.keep load", async () => {
  try {
    const project = await loadProject(projectWith(["tool:WebSearch", "tool:Agent"]));
    assert.deepEqual(project.lean.keep, ["tool:WebSearch", "tool:Agent"]);
  } finally {
    configureTools();
  }
});

test("a kept tool follows the defaults, Skill and ToolSearch, once each", () => {
  assert.deepEqual(toolsFor(["tool:WebSearch", "skill:x"]), [...BASE_TOOLS, "Skill", "WebSearch"]);
  assert.deepEqual(toolsFor(["tool:WebSearch", "mcp:a", "tool:WebSearch", "tool:Agent"]), [...BASE_TOOLS, "ToolSearch", "WebSearch", "Agent"]);
  assert.deepEqual(toolsFor(["tool:Bash"]), BASE_TOOLS);
});

test("the lean check does not report a tool: entry as missing from the repo", async () => {
  const project = await loadProject(projectWith(["tool:WebSearch", "skill:nope"]));
  configureTools();
  assert.deepEqual(unmatched(project, plan(project)).keep, ["skill:nope"]);
});

test("every tool the managed settings deny is a known tool name", () => {
  // DesignSync is denied but is not on the docs page's list; every other name must be, so a misspelt deny is caught.
  const unknown = managedDenied().filter((name) => name !== "DesignSync" && !CLAUDE_CODE_TOOLS.includes(name));
  assert.deepEqual(unknown, []);
  assert.ok(managedDenied().includes("Monitor"));
});
