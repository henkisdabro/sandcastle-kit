// The report schema is on unless REPORT_SCHEMA=0 (#823): with nothing set Claude's command carries the schema flag, `0` is the
// way out, and every Claude pass's `sandbox.run` carries the grace window from one named constant. No Docker, model or network.
//
//   pnpm test:file test/report-schema-default.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-rsd-xdg-"));
delete process.env.REPORT_SCHEMA;
const dflt = await import("../src/agents.ts");
process.env.REPORT_SCHEMA = "0";
const off = (await import(new URL("../src/agents.ts?off", import.meta.url).href)) as typeof import("../src/agents.ts");

const options = { prompt: "do the ticket", dangerouslySkipPermissions: true };

// The Codex command's side is held by test/report-schema-codex.test.ts, whose default instance is this one.
test("with no switch set, Claude's command carries the report schema", () => {
  assert.equal(dflt.REPORT_SCHEMA, true);
  assert.match(dflt.implAgent().buildPrintCommand(options).command, / --output-format stream-json --json-schema '/);
});

test("REPORT_SCHEMA=0 gives the command from before the report, and no capture", () => {
  assert.equal(off.REPORT_SCHEMA, false);
  const agent = off.implAgent();
  assert.ok(!agent.buildPrintCommand(options).command.includes("--json-schema"));
  assert.equal(off.passReport(agent), undefined);
});

test("any value but 0 leaves the report on", async () => {
  process.env.REPORT_SCHEMA = "1";
  const one = (await import(new URL("../src/agents.ts?one", import.meta.url).href)) as typeof import("../src/agents.ts");
  assert.equal(one.REPORT_SCHEMA, true);
  process.env.REPORT_SCHEMA = "0";
});

test("every Claude pass runs with the grace window from one named constant, the library's 60 s", () => {
  assert.equal(dflt.COMPLETION_TIMEOUT_SECONDS, 60);
  const burndown = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.equal(burndown.split("completionTimeoutSeconds").length - 1, 1);
  assert.match(burndown, /sandbox\.run\(\{ \.\.\.opts, completionTimeoutSeconds: COMPLETION_TIMEOUT_SECONDS \}\)/);
});
