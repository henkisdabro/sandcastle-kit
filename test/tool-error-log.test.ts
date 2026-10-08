// The readable agent log shows a failed tool result as one `! ...` line, and calls the library's
// "Context window" line what it is. Temp dirs only; no Docker, no model calls, no network.
//
//   pnpm test:file test/tool-error-log.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Project } from "../src/config.ts";
import { agentLog, agentLogging, rawLog, relabelContextWindow, toolFailureLine } from "../src/run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-tool-error-log-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const result = (content: unknown, isError?: boolean) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content, ...(isError === undefined ? {} : { is_error: isError }) }] } });

test("an is_error result becomes `! error: <first line>`", () => {
  assert.equal(
    toolFailureLine(result("<tool_use_error>Error: No such tool available: Nope</tool_use_error>", true)),
    "! error: Error: No such tool available: Nope",
  );
  assert.equal(toolFailureLine(result([{ type: "text", text: "\n\nfirst\nsecond" }], true)), "! error: first");
});

test("a non-zero exit becomes `! exit N: <first line of output>`", () => {
  assert.equal(toolFailureLine(result("Exit code 1\nsrc/a.ts(3,1): error TS2322: bad\nmore", true)), "! exit 1: src/a.ts(3,1): error TS2322: bad");
  assert.equal(toolFailureLine(result("Exit code 2", true)), "! exit 2");
  // Without is_error, the text alone still says the command failed.
  assert.equal(toolFailureLine(result("Exit code 127\nsh: x: not found")), "! exit 127: sh: x: not found");
});

test("a successful result, other events and non-JSON lines give nothing", () => {
  assert.equal(toolFailureLine(result("fine", false)), undefined);
  assert.equal(toolFailureLine(result("Exit code 0\nok")), undefined);
  assert.equal(toolFailureLine(result("fine")), undefined);
  assert.equal(toolFailureLine('{"type":"assistant","message":{"content":[{"type":"text","text":"tool_result"}]}}'), undefined);
  assert.equal(toolFailureLine("tool_result {not json"), undefined);
});

test("agentLogging puts the failure line in the readable log and the raw line in the sidecar", () => {
  const root = join(TMP, "p");
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  const project = { root, baseBranch: "main" } as Project;
  const logging = agentLogging(project, "7", "impl-7", "run-1") as { onAgentStreamEvent: (e: unknown) => void };
  const bad = result("Exit code 1\nboom", true);
  logging.onAgentStreamEvent({ type: "raw", line: bad, iteration: 1, timestamp: new Date() });
  logging.onAgentStreamEvent({ type: "raw", line: result("fine", false), iteration: 1, timestamp: new Date() });
  const log = agentLog(project, "7", "impl-7");
  assert.match(readFileSync(log, "utf8"), /^! exit 1: boom$/m);
  assert.equal((readFileSync(log, "utf8").match(/^!/gm) ?? []).length, 1);
  assert.ok(readFileSync(rawLog(log), "utf8").includes(bad));
});

test("relabelContextWindow renames the library's line and leaves everything else", () => {
  const file = join(TMP, "agent.log");
  writeFileSync(file, "Run complete\nContext window: 8549k\nthe agent said: Context window: 1k\nContext window: 12k\n");
  relabelContextWindow(file);
  assert.equal(readFileSync(file, "utf8"), "Run complete\nTokens processed (all turns): 8549k\nthe agent said: Context window: 1k\nTokens processed (all turns): 12k\n");
  relabelContextWindow(file);
  assert.match(readFileSync(file, "utf8"), /^Tokens processed \(all turns\): 8549k$/m);
  relabelContextWindow(join(TMP, "missing.log"));
});
