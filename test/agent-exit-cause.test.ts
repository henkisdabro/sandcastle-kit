// The cause of an agent process that exited non-zero: in the crashed note (`agentFailure`) and at the end of the pass's
// readable log (`logAgentExit`), as Sandcastle 0.14 words the error (a plain Error, no Docker or model).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { agentFailure } = await import("../src/agents.ts");
const { logAgentExit, logSaysLimit } = await import("../src/run.ts");
const { hideFromGates } = await import("../src/worktree-lock.ts");

const SECRET = "sk-ant-test-0123456789";
const exited = (detail: string) => new Error(`(FiberFailure) AgentError: claude-code exited with code 1:\n${detail}`);
const tempLog = (initial = "") => {
  const path = join(mkdtempSync(join(tmpdir(), "agent-exit-")), "agent.log");
  writeFileSync(path, initial);
  return path;
};

test("the crashed note carries the process's stderr line", () => {
  assert.equal(agentFailure(exited("Invalid API key · Please run /login")), "claude-code exited with code 1: Invalid API key · Please run /login");
});

test("the crashed note stays the first line when the detail is only stream JSON", () => {
  assert.equal(agentFailure(exited('{"type":"system"}\n{"type":"result","is_error":true}')), "claude-code exited with code 1");
});

test("a registered secret never reaches the note or the log, near the cut too", () => {
  hideFromGates([SECRET]);
  assert.equal(agentFailure(exited(`bad key ${SECRET}`)), "claude-code exited with code 1: bad key <redacted>");
  // Starting near character 150 of the joined text: redacting before the cut leaves no part of it.
  const padded = exited(`${"word ".repeat(26)}${SECRET} tail`);
  const note = agentFailure(padded);
  assert.ok(!note.includes("sk-ant"), note);
  assert.ok(!note.includes("0123456789"), note);
  assert.equal(agentFailure(new Error(`AgentError: claude-code reported an error:\n${SECRET}`)), "claude-code reported an error: <redacted>");
  assert.equal(agentFailure(new Error(`AgentError: claude-code exited with code 1:\n[claude-code:bad_key] ${SECRET}`)), "claude-code exited with code 1 - bad key");
  const log = tempLog();
  logAgentExit({ type: "file", path: log }, exited(`a ${SECRET} b`));
  const text = readFileSync(log, "utf8");
  assert.ok(!text.includes(SECRET));
  assert.match(text, /a <redacted> b/);
});

test("the pass log gets the error line and the indented detail", () => {
  const log = tempLog("Agent started\n");
  logAgentExit({ type: "file", path: log }, exited("Invalid API key\n\n  Please run /login\n"));
  assert.equal(readFileSync(log, "utf8"), "Agent started\n! error: claude-code exited with code 1\n  Invalid API key\n    Please run /login\n");
});

test("100 lines of detail leave the last 40 with the cut line before them", () => {
  const log = tempLog();
  logAgentExit({ type: "file", path: log }, exited(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")));
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 42);
  assert.equal(lines[1], "  [... 60 lines cut ...]");
  assert.equal(lines[2], "  line 61");
  assert.equal(lines[41], "  line 100");
});

test("empty lines are dropped before the cap and the cut count", () => {
  const log = tempLog();
  logAgentExit({ type: "file", path: log }, exited(Array.from({ length: 100 }, (_, i) => (i % 2 ? "" : `line ${i}`)).join("\n")));
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 42);
  assert.equal(lines[1], "  [... 10 lines cut ...]");
});

test("a log that ends in the agent's limit line still reads as limit-hit after the crash detail", () => {
  const before = "Agent started\nYou've hit your session limit\n";
  assert.ok(logSaysLimit(before));
  const log = tempLog(before);
  // The call site reads the log first (passHitLimit), then appends: the order is the source-match test's.
  logAgentExit({ type: "file", path: log }, exited("x"));
  assert.ok(readFileSync(log, "utf8").startsWith(before));
});

test("nothing is written for another error, an expansion failure or a log that is no file", () => {
  const log = tempLog("start\n");
  const file = { type: "file" as const, path: log };
  logAgentExit(file, new Error("(FiberFailure) AgentError: claude-code reported an error:\nAPI Error: 529"));
  logAgentExit(file, new Error("claude-code exited with code 1:"));
  logAgentExit(file, new Error("Prompt expansion failed: gh: HTTP 502"));
  logAgentExit({ type: "stdout" }, exited("detail"));
  logAgentExit(undefined, exited("detail"));
  logAgentExit({ type: "file", path: join(tmpdir(), "no-such-dir-agent-exit", "x.log") }, exited("detail"));
  assert.equal(readFileSync(log, "utf8"), "start\n! error: claude-code exited with code 1\n");
});

test("burndown calls the helper in the pass's catch, after the limit check reads the log", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /logAgentExit\(opts\.logging, error\)/);
  assert.ok(src.indexOf("passHitLimit(opts.logging, logFrom)") < src.indexOf("logAgentExit(opts.logging, error)"));
});
