// What a failed preflight tells the operator: one reply line when every model said the same,
// and the credential's key and file (never its value) when the reply looks like a rejection.
//
//   pnpm exec tsx --test test/preflight.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing the kit must not touch the real slots or the real credentials file.
const home = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = join(home, "cache");
process.env.XDG_CONFIG_HOME = join(home, "config");
const { preflightFailure } = await import("../src/run.ts");
const { credentialSource, USER_CONFIG } = await import("../src/sandbox.ts");

const credential = { key: "CLAUDE_CODE_OAUTH_TOKEN", file: join("project", ".sandcastle", ".env") };
const noBody = "API Error: 400 (no body)";

test("an identical 400-no-body reply prints once and names the credential's file", () => {
  const text = preflightFailure(
    [
      { model: "sonnet", reply: noBody },
      { model: "opus", reply: noBody },
    ],
    credential,
  );
  assert.ok(text.startsWith("NOT STARTED: Preflight failed - no sandbox started"));
  assert.equal(text.split(noBody).length - 1, 1, "the reply appears once");
  assert.ok(text.includes(`sonnet, opus: ${noBody}`));
  assert.ok(text.includes(`The credential was likely rejected: CLAUDE_CODE_OAUTH_TOKEN from ${credential.file}.`));
  assert.ok(text.includes("claude setup-token"));
});

test("different replies print both lines and no credential hint", () => {
  const text = preflightFailure(
    [
      { model: "sonnet", reply: "API Error: 401 invalid token" },
      { model: "opus", reply: "You have hit your usage limit" },
    ],
    credential,
  );
  assert.ok(text.includes("sonnet: API Error: 401 invalid token"));
  assert.ok(text.includes("opus: You have hit your usage limit"));
  assert.ok(!text.includes("credential"));
});

test("an identical reply that is not an auth rejection carries no hint", () => {
  const text = preflightFailure(
    [
      { model: "sonnet", reply: "model not found" },
      { model: "opus", reply: "model not found" },
    ],
    credential,
  );
  assert.ok(text.includes("sonnet, opus: model not found"));
  assert.ok(!text.includes("credential"));
});

test("no credential found means no hint", () => {
  const text = preflightFailure([{ model: "sonnet", reply: noBody }], undefined);
  assert.ok(!text.includes("credential"));
});

test("the credential comes from the project's file when it defines the key, else the user's", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-test-project-"));
  mkdirSync(join(root, ".sandcastle"));
  mkdirSync(USER_CONFIG, { recursive: true });
  const project = { root } as Parameters<typeof credentialSource>[0];
  const userFile = join(USER_CONFIG, ".env");
  const projectFile = join(root, ".sandcastle/.env");

  assert.equal(credentialSource(project), undefined);

  writeFileSync(userFile, "ANTHROPIC_API_KEY=sk-user\nGH_TOKEN=github_pat_x\n");
  assert.deepEqual(credentialSource(project), { key: "ANTHROPIC_API_KEY", file: userFile });

  writeFileSync(userFile, "CLAUDE_CODE_OAUTH_TOKEN=tok-user\nANTHROPIC_API_KEY=sk-user\n");
  assert.deepEqual(credentialSource(project), { key: "CLAUDE_CODE_OAUTH_TOKEN", file: userFile });

  writeFileSync(projectFile, "CLAUDE_CODE_OAUTH_TOKEN=tok-project\n");
  assert.deepEqual(credentialSource(project), { key: "CLAUDE_CODE_OAUTH_TOKEN", file: projectFile });
});
