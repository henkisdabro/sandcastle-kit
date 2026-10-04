// The usage guard reads plan usage with the host's Claude Code login, read-only: the macOS keychain
// entry or the Linux credentials file (under CLAUDE_CONFIG_DIR), never expired, never refreshed, and
// never in a sandbox's environment or mounts. Injected readers and a stubbed fetch; no real
// keychain, network or model calls.
//
//   pnpm exec tsx --test test/usage-login.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

process.env.USAGE_CHECK = "1";
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-usage-login-xdg-"));
const { hostLoginReaders, usageToken, usageLine, usageStop } = await import("../src/usage.ts");
const { fakeTracker } = await import("./fixtures.ts");
const { sandboxEnv, sandboxMounts } = await import("../src/sandbox.ts");

const NOW = Date.UTC(2026, 9, 4, 12);
const login = (accessToken: unknown, expiresAt: unknown = NOW + 3_600_000) => JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, refreshToken: "refresh-secret" } });
const none = { keychain: () => undefined, file: () => undefined };
const env = { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" };

test("macOS reads the keychain entry, never the file", () => {
  const readers = { keychain: () => login("keychain-token"), file: () => assert.fail("macOS does not read the file") as never };
  assert.deepEqual(usageToken(env, "darwin", readers, NOW), { source: "login", token: "keychain-token" });
});

test("Linux reads the credentials file, never the keychain", () => {
  const readers = { keychain: () => assert.fail("Linux has no keychain") as never, file: () => login("file-token") };
  assert.deepEqual(usageToken(env, "linux", readers, NOW), { source: "login", token: "file-token" });
});

test("the real file reader looks under CLAUDE_CONFIG_DIR, and finds nothing where there is no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-usage-login-"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    assert.equal(hostLoginReaders.file(), undefined);
    writeFileSync(join(dir, ".credentials.json"), login("dir-token"));
    assert.deepEqual(usageToken({}, "linux", hostLoginReaders, NOW), { source: "login", token: "dir-token" });
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("an expired login is no reading: it does not fall back to the setup token", () => {
  assert.deepEqual(usageToken(env, "linux", { ...none, file: () => login("old", NOW - 1) }, NOW), { source: "login expired" });
  assert.deepEqual(usageToken(env, "linux", { ...none, file: () => login("old", NOW) }, NOW), { source: "login expired" });
  // An expiry that is not a number is a token of unknown age: not sent.
  assert.deepEqual(usageToken(env, "linux", { ...none, file: () => login("old", "soon") }, NOW), { source: "login expired" });
});

test("a missing entry falls back to CLAUDE_CODE_OAUTH_TOKEN, and with that unset there is no credential", () => {
  assert.deepEqual(usageToken(env, "darwin", none, NOW), { source: "CLAUDE_CODE_OAUTH_TOKEN", token: "setup-token" });
  assert.deepEqual(usageToken(env, "linux", none, NOW), { source: "CLAUDE_CODE_OAUTH_TOKEN", token: "setup-token" });
  assert.equal(usageToken({}, "linux", none, NOW), undefined);
});

test("malformed JSON, or JSON with no access token, falls back", () => {
  for (const raw of ["", "not json", "null", "[]", "{}", JSON.stringify({ claudeAiOauth: {} }), login(""), login(42), JSON.stringify({ claudeAiOauth: null })]) {
    assert.deepEqual(usageToken(env, "linux", { ...none, file: () => raw }, NOW), { source: "CLAUDE_CODE_OAUTH_TOKEN", token: "setup-token" }, raw);
  }
  assert.equal(usageToken({}, "darwin", { ...none, keychain: () => "{broken" }, NOW), undefined);
});

test("a reader that throws is no login", () => {
  const throws = () => {
    throw new Error("keychain locked");
  };
  assert.deepEqual(usageToken(env, "darwin", { keychain: throws, file: throws }, NOW), { source: "CLAUDE_CODE_OAUTH_TOKEN", token: "setup-token" });
});

const withFetch = async (status: number, body: () => Promise<void>) => {
  const real = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(String((init?.headers as Record<string, string>).Authorization));
    return new Response(JSON.stringify({ five_hour: { utilization: 42 } }), { status });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
  return sent;
};

test("the guard reads with the login's token, not the setup token, and the line never prints either", async () => {
  const readers = { ...none, file: () => login("login-token-xyz", Date.now() + 3_600_000) };
  // process.platform decides the source; on macOS the keychain reader is the one read.
  const both = { keychain: readers.file, file: readers.file };
  let line: string | undefined;
  const sent = await withFetch(200, async () => {
    line = await usageLine(env, both);
  });
  assert.deepEqual(sent, ["Bearer login-token-xyz"]);
  assert.match(line ?? "", /^Plan usage: five_hour 42%/);
  assert.doesNotMatch(line ?? "", /login-token-xyz|setup-token/);
});

test("an expired login makes the guard say so and fail open, with no request", async () => {
  const stale = login("login-token-old", Date.now() - 1000);
  const readers = { keychain: () => stale, file: () => stale };
  let line: string | undefined;
  let stop: string | undefined = "unset";
  const sent = await withFetch(200, async () => {
    line = await usageLine(env, readers);
    stop = await usageStop(env, readers);
  });
  assert.deepEqual(sent, []);
  assert.match(line ?? "", /^Plan usage: unknown right now \(the Claude Code login has expired/);
  assert.equal(stop, undefined);
});

test("reading the login adds nothing to the credentials env the run holds", async () => {
  const held = { ...env };
  const readers = { keychain: () => login("login-token-xyz"), file: () => login("login-token-xyz") };
  await withFetch(200, async () => {
    await usageLine(held, readers);
    await usageStop(held, readers);
  });
  assert.deepEqual(held, env);
});

test("the login's token never reaches the sandbox environment or mounts the kit builds", () => {
  const xdg = process.env.XDG_CONFIG_HOME as string;
  mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
  writeFileSync(join(xdg, "sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=setup-token\nGH_TOKEN=github_pat_fake\n", { mode: 0o600 });
  const config = mkdtempSync(join(tmpdir(), "sandcastle-usage-login-claude-"));
  writeFileSync(join(config, ".credentials.json"), login("login-token-xyz"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const project = { root: mkdtempSync(join(tmpdir(), "sandcastle-usage-login-proj-")), mounts: [], tracker: fakeTracker() } as never;
    const sandbox = sandboxEnv(project);
    assert.equal(sandbox.CLAUDE_CODE_OAUTH_TOKEN, "setup-token");
    const everything = JSON.stringify({ env: sandbox, mounts: sandboxMounts(project) });
    assert.doesNotMatch(everything, /login-token-xyz|refresh-secret|credentials\.json/);
    assert.ok(!everything.includes(config));
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("doctor --verify says which credential the guard would use and the HTTP status, never the token", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-usage-login-doctor-"));
  const xdg = join(cwd, "xdg");
  mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
  writeFileSync(join(xdg, "sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n", { mode: 0o600 });
  const claude = join(cwd, "claude");
  mkdirSync(claude);
  // The one reading's answer depends on who asks: the login's token gets 200, the setup token 403.
  const preload = join(cwd, "stub.mjs");
  writeFileSync(preload, 'globalThis.fetch = async (_u, init) => new Response("{}", { status: String(init?.headers?.Authorization).includes("login-token-xyz") ? 200 : 403 });\n');
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  // macOS asks `security`; this one answers for the keychain there, and on Linux the file is read.
  writeFileSync(join(bin, "security"), `#!/bin/sh\ncat <<'EOF'\n${login("login-token-xyz", Date.now() + 3_600_000)}\nEOF\n`, { mode: 0o755 });
  writeFileSync(join(claude, ".credentials.json"), login("login-token-xyz", Date.now() + 3_600_000));
  const run = () =>
    runKit(["doctor", "--verify"], {
      cwd,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: claude, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, XDG_CONFIG_HOME: xdg, GIT_CEILING_DIRECTORIES: tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  const r = run();
  assert.match(r.stdout, /ok\s+usage guard \(USAGE_CHECK=1\) would read plan usage with the Claude Code login - the usage endpoint answered HTTP 200/, r.stdout + r.stderr);
  // The setup token's own 403 is not the guard's problem while the login is what it reads with.
  assert.doesNotMatch(r.stdout, /cannot work with this token/);
  assert.doesNotMatch(r.stdout + r.stderr, /login-token-xyz|refresh-secret/);
});
