// `"attribution": false` in the personal config.json gives every Claude pass Claude Code's own "no attribution"
// settings through `--settings`, which outranks the branch's own settings; anything else leaves the command as it was.
// The run resolves it once, with its other settings, so what it does and what its record says cannot differ.
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
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");

const options = { prompt: "do the ticket", dangerouslySkipPermissions: true };
const FLAG = `--settings '{"attribution":{"commit":"","pr":"","sessionUrl":false},"includeCoAuthoredBy":false}'`;
const resolve = (machine: Record<string, unknown>) => resolveSettings({ env: {}, project: {}, machine });

test("by default a pass's command sets no attribution", () => {
  agents.configureAttribution(resolve({}).attribution);
  assert.ok(!agents.implAgent().buildPrintCommand(options).command.includes("--settings"));
});

test("false gives implement and resolve passes empty commit and PR attribution", () => {
  agents.configureAttribution(resolve({ attribution: false }).attribution);
  for (const agent of [agents.implAgent(), agents.resolveAgent()]) {
    assert.ok(agent.buildPrintCommand(options).command.includes(` ${FLAG} `));
  }
  agents.configureAttribution(true);
});

test("only the boolean false turns it off", () => {
  for (const value of [true, "false", 0, undefined]) assert.equal(resolve({ attribution: value }).attribution, true, String(value));
  assert.equal(resolve({ attribution: false }).attribution, false);
});

test("the run record carries attribution only when it is off", () => {
  assert.ok(!("attribution" in settingsGroup(resolve({}), 1)));
  assert.equal(settingsGroup(resolve({ attribution: false }), 1).attribution, false);
});
