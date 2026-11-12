// With CROSS_REVIEW=1 a sandbox gets the host's Codex login with its refresh token blanked: a refresh
// rotates the token server-side, so copies that each kept it would be spent by the first sandbox to refresh.
//
//   pnpm test:file test/codex-auth-copy.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Read at import: the flag, and the home the login is read from.
process.env.CROSS_REVIEW = "1";
const home = mkdtempSync(join(tmpdir(), "sandcastle-codexcopy-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// The suite shares its outer TMPDIR across test files; cleanup must inspect only this run's copies.
process.env.TMPDIR = home;
const { sandboxMounts, removeCodexAuthCopy } = await import("../src/sandbox.ts");

const project = { mounts: [] } as unknown as Project;
const authFile = join(home, ".codex", "auth.json");
mkdirSync(join(home, ".codex"));

const login = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: "made-up-id", access_token: "made-up-access", refresh_token: "made-up-refresh", account_id: "acct-1" },
  last_refresh: "2026-01-01T00:00:00Z",
};
const codexMount = () => {
  const mount = sandboxMounts(project).find((m) => m.sandboxPath === "/home/agent/.codex-host/auth.json");
  assert.ok(mount);
  return mount;
};
const copiesUnderTemp = () => readdirSync(tmpdir()).filter((n) => n.startsWith("sandcastle-codex-"));

test("a cross-review sandbox's login has an empty refresh token and every other value of the host's", () => {
  const text = JSON.stringify(login, null, 2);
  writeFileSync(authFile, text);
  const mount = codexMount();
  assert.notEqual(mount.hostPath, "~/.codex/auth.json");
  assert.equal(mount.readonly, true);
  const copy = JSON.parse(readFileSync(mount.hostPath, "utf8"));
  assert.deepEqual(copy, { ...login, tokens: { ...login.tokens, refresh_token: "" } });
  assert.equal(readFileSync(authFile, "utf8"), text, "the host's login is only read");
  removeCodexAuthCopy();
});

test("every sandbox of a run gets the same one copy", () => {
  writeFileSync(authFile, JSON.stringify(login));
  const first = codexMount().hostPath;
  assert.equal(codexMount().hostPath, first);
  removeCodexAuthCopy();
});

test("an API-key sign-in is mounted unchanged", () => {
  writeFileSync(authFile, JSON.stringify({ OPENAI_API_KEY: "sk-made-up", tokens: null }));
  assert.equal(codexMount().hostPath, "~/.codex/auth.json");
});

test("a login with no refresh token is mounted unchanged", () => {
  writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "made-up-access" } }));
  assert.equal(codexMount().hostPath, "~/.codex/auth.json");
});

test("a malformed login is mounted as before", () => {
  writeFileSync(authFile, "{ not json");
  assert.equal(codexMount().hostPath, "~/.codex/auth.json");
});

test("an unreadable login leaves the mount as before", () => {
  rmSync(authFile);
  mkdirSync(authFile);
  try {
    assert.equal(codexMount().hostPath, "~/.codex/auth.json");
  } finally {
    rmSync(authFile, { recursive: true });
  }
});

test("no copy of the login remains once the run's exit handler has run", () => {
  writeFileSync(authFile, JSON.stringify(login));
  const { hostPath } = codexMount();
  assert.ok(existsSync(hostPath));
  assert.ok(process.listeners("exit").includes(removeCodexAuthCopy));
  removeCodexAuthCopy();
  assert.equal(existsSync(hostPath), false);
  assert.deepEqual(copiesUnderTemp(), []);
});
