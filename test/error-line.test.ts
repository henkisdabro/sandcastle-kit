// errorLine is what a summary line shows of a failure: "closing the ticket failed: Error: gh issue
// close failed: ..." carried String(error)'s prefix. The message alone, or the command's last stderr line.
//
//   node --test test/error-line.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { errorLine } from "../src/sandbox.ts";

test("an Error gives its message, with no Error: prefix", () => {
  assert.equal(errorLine(new Error("gh issue close failed: HTTP 502\nmore")), "gh issue close failed: HTTP 502");
});

test("a failed command gives its last stderr line", () => {
  assert.equal(errorLine(Object.assign(new Error("Command failed"), { stderr: "warning\nHTTP 502: Bad Gateway\n" })), "HTTP 502: Bad Gateway");
});

test("agentFailure: the library's two-line agent error reads as one line with its cause", async () => {
  const { agentFailure } = await import("../src/agents.ts");
  const e = new Error('(FiberFailure) AgentError: claude-code exited with code 1:\n[claude-code:unrecognized_model] {"model":"claude-nonexistent-9"}');
  assert.equal(agentFailure(e), "claude-code exited with code 1 - unrecognized model");
  assert.equal(agentFailure(new Error("Error: boom")), "boom");
});

test("a commit git could not sign says so, and what to do", () => {
  const e = Object.assign(new Error("Command failed: git merge"), { stderr: "error: 1Password: agent refused operation\nfatal: failed to write commit object\n" });
  assert.equal(errorLine(e), "fatal: failed to write commit object - git could not sign the commit (commit.gpgsign is on): unlock your signing agent (1Password, gpg-agent), then try again");
  assert.equal(errorLine(new Error("fatal: not a git repository")), "fatal: not a git repository");
});
