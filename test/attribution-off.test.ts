// `"attribution": false` in the personal config.json gives every Claude pass Claude Code's own "no attribution"
// settings through `--settings`, which outranks the branch's own settings; anything else leaves the command as it was.
// No Docker, model or network.
//
//   pnpm test:file test/attribution-off.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-attr-xdg-"));
const agents = await import("../src/agents.ts");

const options = { prompt: "do the ticket", dangerouslySkipPermissions: true };
const FLAG = `--settings '{"attribution":{"commit":"","pr":"","sessionUrl":false}}'`;

test("by default a pass's command sets no attribution", () => {
  agents.configureAttribution(undefined);
  assert.ok(!agents.implAgent().buildPrintCommand(options).command.includes("--settings"));
});

test("false gives implement and resolve passes empty commit and PR attribution", () => {
  agents.configureAttribution(false);
  for (const agent of [agents.implAgent(), agents.resolveAgent()]) {
    assert.ok(agent.buildPrintCommand(options).command.includes(` ${FLAG} `));
  }
  agents.configureAttribution(undefined);
});

test("only the boolean false turns it off", () => {
  for (const value of [true, "false", 0]) {
    agents.configureAttribution(value);
    assert.ok(!agents.implAgent().buildPrintCommand(options).command.includes("--settings"), String(value));
  }
});
