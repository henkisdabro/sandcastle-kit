// The usage guard reads the host's Claude Code login only when the sandboxes spend a subscription
// token (CLAUDE_CODE_OAUTH_TOKEN): with ANTHROPIC_API_KEY, alone or beside it, it says it does not apply, and where it
// reads, the start line and `doctor --verify` say whose plan that is. Injected login readers, a
// stubbed fetch and a stub `security`; no real keychain, network or model calls.
//
//   pnpm exec tsx --test test/usage-plan-applies.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

process.env.USAGE_CHECK = "1";
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-usage-plan-xdg-"));
const { usageToken, usageLine, usageStop, usageReadingLost } = await import("../src/usage.ts");

const NOW = Date.UTC(2026, 9, 4, 12);
const login = JSON.stringify({ claudeAiOauth: { accessToken: "login-token-xyz", expiresAt: NOW + 3_600_000 } });
const readers = { keychain: () => login, file: () => login };

test("with an API key the host login is not read, whatever platform", () => {
  const unread = { keychain: () => assert.fail("the login is not read") as never, file: () => assert.fail("the login is not read") as never };
  for (const platform of ["darwin", "linux"] as const) {
    assert.deepEqual(usageToken({ ANTHROPIC_API_KEY: "sk-ant-api03-fake" }, platform, unread, NOW), { source: "api key" });
  }
});

test("with no credential at all the host login is not read either", () => {
  assert.equal(usageToken({}, "linux", readers, NOW), undefined);
});

test("an API key wins over a subscription token, as Claude Code spends it first: the guard does not apply and the login is not read", () => {
  const unread = { keychain: () => assert.fail("the login is not read") as never, file: () => assert.fail("the login is not read") as never };
  assert.deepEqual(usageToken({ CLAUDE_CODE_OAUTH_TOKEN: "setup", ANTHROPIC_API_KEY: "sk-ant-api03-fake" }, "linux", unread, NOW), { source: "api key" });
});

test("a subscription token alone reads the login", () => {
  assert.deepEqual(usageToken({ CLAUDE_CODE_OAUTH_TOKEN: "setup" }, "linux", readers, NOW), { source: "login", token: "login-token-xyz" });
});

const withFetch = async (body: () => Promise<void>) => {
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (async () => {
    asked++;
    return new Response(JSON.stringify({ five_hour: { utilization: 99 } }), { status: 200 });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
  return asked;
};

test("with an API key the start line says the guard does not apply, asks nothing and never stops a ticket", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-api03-fake" };
  let line: string | undefined;
  let stop: string | undefined = "unset";
  const asked = await withFetch(async () => {
    line = await usageLine(env, readers);
    stop = await usageStop(env, readers);
  });
  assert.equal(asked, 0);
  assert.match(line ?? "", /^Plan usage: the guard does not apply - the sandboxes spend ANTHROPIC_API_KEY/);
  assert.doesNotMatch(line ?? "", /sk-ant|login-token-xyz/);
  assert.equal(stop, undefined);
  // Not guarding: the run record says so, as it does for any attempt that got no reading.
  assert.equal(usageReadingLost(), true);
});

test("the start line says whose plan is read: the login's account, or the token's", async () => {
  let viaLogin: string | undefined;
  let viaToken: string | undefined;
  await withFetch(async () => {
    viaLogin = await usageLine({ CLAUDE_CODE_OAUTH_TOKEN: "setup" }, readers);
  });
  assert.match(viaLogin ?? "", /^Plan usage: five_hour 99% \(no new ticket starts at 90%\)\. Read for the Claude Code login's account on this machine \(the sandboxes spend CLAUDE_CODE_OAUTH_TOKEN/);
  await withFetch(async () => {
    viaToken = await usageLine({ CLAUDE_CODE_OAUTH_TOKEN: "setup" }, { keychain: () => undefined, file: () => undefined });
  });
  assert.match(viaToken ?? "", /Read for CLAUDE_CODE_OAUTH_TOKEN's account/);
});

test("doctor --verify says the guard does not apply with an API key, and whose plan it reads otherwise", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-usage-plan-doctor-"));
  const claude = join(cwd, "claude");
  mkdirSync(claude);
  const preload = join(cwd, "stub.mjs");
  writeFileSync(preload, 'globalThis.fetch = async () => new Response("{}", { status: 200 });\n');
  // A login live at the child's own clock, not at NOW.
  const live = JSON.stringify({ claudeAiOauth: { accessToken: "login-token-xyz", expiresAt: Date.now() + 3_600_000 } });
  writeFileSync(join(claude, ".credentials.json"), live);
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "security"), `#!/bin/sh\ncat <<'EOF'\n${live}\nEOF\n`, { mode: 0o755 });
  const doctor = (envFile: string) => {
    const xdg = mkdtempSync(join(cwd, "xdg-"));
    mkdirSync(join(xdg, "sandcastle-kit"));
    writeFileSync(join(xdg, "sandcastle-kit/.env"), envFile, { mode: 0o600 });
    return runKit(["doctor", "--verify"], {
      cwd,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: claude, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, XDG_CONFIG_HOME: xdg, GIT_CEILING_DIRECTORIES: tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  };
  const api = doctor("ANTHROPIC_API_KEY=sk-ant-api03-fake\n");
  assert.match(api.stdout, /info\s+usage guard \(USAGE_CHECK=1\) does not apply: the sandboxes spend ANTHROPIC_API_KEY/, api.stdout + api.stderr);
  assert.doesNotMatch(api.stdout, /would read plan usage/);
  const oauth = doctor("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n");
  assert.match(oauth.stdout, /would read plan usage with the Claude Code login - the usage endpoint answered HTTP 200 - the Claude Code login's account on this machine \(the sandboxes spend CLAUDE_CODE_OAUTH_TOKEN/, oauth.stdout + oauth.stderr);
  assert.doesNotMatch(api.stdout + oauth.stdout, /login-token-xyz/);
});
