// errorLine is what a summary line shows of a failure: "closing the ticket failed: Error: gh issue
// close failed: ..." carried String(error)'s prefix. The message alone, or the command's last stderr line.
//
//   pnpm test:file test/error-line.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { errorLine } from "../src/sandbox.ts";

test("an Error gives its message, with no Error: prefix", () => {
  assert.equal(errorLine(new Error("gh issue close failed: HTTP 502\nmore")), "gh issue close failed: HTTP 502");
});

test("a failed command gives its last stderr line", () => {
  assert.equal(errorLine(Object.assign(new Error("Command failed"), { stderr: "warning\nHTTP 502: Bad Gateway\n" })), "HTTP 502: Bad Gateway");
});

test("a message holding a command's stderr gives its fatal: line, not git's progress line before it", () => {
  const e = new Error("Preparing worktree (new branch 'sandcastle/land-agent-issue-7-1')\nfatal: cannot lock ref 'refs/heads/sandcastle/land-agent-issue-7-1': Unable to create '.git/refs/heads/sandcastle/land-agent-issue-7-1.lock': File exists.");
  assert.match(errorLine(e), /^fatal: cannot lock ref/);
});

test("agentFailure: the library's two-line agent error reads as one line with its cause", async () => {
  const { agentFailure } = await import("../src/agents.ts");
  const e = new Error('(FiberFailure) AgentError: claude-code exited with code 1:\n[claude-code:unrecognized_model] {"model":"claude-nonexistent-9"}');
  assert.equal(agentFailure(e), "claude-code exited with code 1 - unrecognized model");
  assert.equal(agentFailure(new Error("Error: boom")), "boom");
});

// From Sandcastle 0.13.0 an error the agent reports in its stream fails the iteration with the cause on the line after
// "reported an error:"; the note keeps it.
test("agentFailure: claude's in-stream error (a result with is_error) keeps its cause", async () => {
  const { agentFailure } = await import("../src/agents.ts");
  const e = new Error("(FiberFailure) AgentError: claude-code reported an error:\n\nAPI Error: 529 Overloaded\nmore detail");
  assert.equal(agentFailure(e), "claude-code reported an error: API Error: 529 Overloaded");
});

test("agentFailure: codex's turn.failed keeps its cause", async () => {
  const { agentFailure } = await import("../src/agents.ts");
  const e = new Error("(FiberFailure) AgentError: codex reported an error:\n  stream disconnected before completion\n");
  assert.equal(agentFailure(e), "codex reported an error: stream disconnected before completion");
  // A first line with no cause after it reads as before.
  assert.equal(agentFailure(new Error("AgentError: codex reported an error:\n")), "codex reported an error");
});

test("agentFailure: no other line is joined - not after an exit code, and never JSON", async () => {
  const { agentFailure } = await import("../src/agents.ts");
  // With stderr empty, Sandcastle's exit-code error carries the stream's last lines: the note stays the first line.
  const exited = new Error('(FiberFailure) AgentError: claude-code exited with code 1:\n{"type":"result","subtype":"error_during_execution","is_error":true}');
  assert.equal(agentFailure(exited), "claude-code exited with code 1");
  assert.equal(agentFailure(new Error("AgentError: codex exited with code 2:\nsome text")), "codex exited with code 2");
  assert.equal(agentFailure(new Error('AgentError: claude-code reported an error:\n{"type":"result"}')), "claude-code reported an error");
  assert.equal(agentFailure(new Error("AgentError: claude-code reported an error:\n[1, 2]")), "claude-code reported an error");
});

test("a commit git could not sign says so, and what to do", () => {
  const e = Object.assign(new Error("Command failed: git merge"), { stderr: "error: 1Password: agent refused operation\nfatal: failed to write commit object\n" });
  assert.equal(errorLine(e), "fatal: failed to write commit object - git could not sign the commit (commit.gpgsign is on): unlock your signing agent (1Password, gpg-agent), then try again");
  assert.equal(errorLine(new Error("fatal: not a git repository")), "fatal: not a git repository");
});
