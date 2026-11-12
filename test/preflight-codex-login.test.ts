// A failed Codex preflight probe: its reason without the CLI's repeats and tracing lines, and the
// fix for a stale host login (a new `codex login`), never the Claude credential's file.
//
//   pnpm test:file test/preflight-codex-login.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing the kit must not touch the real slots or the real credentials file.
const home = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = join(home, "cache");
process.env.XDG_CONFIG_HOME = join(home, "config");
const { codexReply, preflightFailure } = await import("../src/run.ts");

// The shape a rotated-away ChatGPT login printed: the same error twice, then a tracing line.
const stale = [
  "ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
  "ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
  "2026-01-01T10:00:00.301810Z ERROR codex_login: refresh failed",
  "",
].join("\n");

test("the Codex reply keeps the error once and drops the tracing line", () => {
  assert.equal(codexReply(stale), "ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.");
});

test("a stale Codex login names the fix on this machine, not the Claude credential", () => {
  const text = preflightFailure([{ model: "gpt-x", reply: codexReply(stale) }], undefined, "gpt-x");
  assert.match(text, /codex logout && codex login/);
  assert.match(text, /without CROSS_REVIEW/);
  assert.doesNotMatch(text, /claude setup-token/);
});

test("a Codex failure that is not a login problem gets no login hint, nor does a run without cross-review", () => {
  assert.doesNotMatch(preflightFailure([{ model: "gpt-x", reply: "model not found" }], undefined, "gpt-x"), /codex login/);
  assert.doesNotMatch(preflightFailure([{ model: "sonnet", reply: "refresh token expired" }], undefined), /codex login/);
});
