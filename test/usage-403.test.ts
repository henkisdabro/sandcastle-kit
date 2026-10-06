// USAGE_CHECK=1 and a token that cannot read plan usage: a 403 turns the guard off for the run and
// the endpoint is not asked again; a 429 still fails open and is asked again before the next ticket.
// A stubbed fetch for the endpoint; no network or model calls.
//
//   node --test test/usage-403.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

process.env.USAGE_CHECK = "1";
const { usageLine, usageStop: stopWith } = await import("../src/usage.ts");

// No host login: these tests are about the setup token, whatever login the machine running them has.
const noLogin = { keychain: () => undefined, file: () => undefined };
const usageStop = (env: Record<string, string>) => stopWith(env, noLogin);

const stubbed = async (status: number, body: () => Promise<void>) => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
  return () => calls;
};

test("a 403 says the guard is off for this run and the endpoint is asked no more", async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "token-403" };
  let line: string | undefined;
  const calls = await stubbed(403, async () => {
    line = await usageLine(env, noLogin);
    assert.equal(await usageStop(env), undefined);
    assert.equal(await usageStop(env), undefined);
    assert.match((await usageLine(env, noLogin)) ?? "", /guard is off for this run/);
  });
  assert.match(line ?? "", /^Plan usage: the usage guard is off for this run \(the usage endpoint answered HTTP 403/);
  assert.doesNotMatch(line ?? "", /unknown right now/);
  assert.equal(calls(), 1);
});

test("a 429 fails open and the next ticket asks again", async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "token-429" };
  const calls = await stubbed(429, async () => {
    assert.match((await usageLine(env, noLogin)) ?? "", /^Plan usage: unknown right now \(the usage endpoint answered HTTP 429, rate-limited\); the run goes ahead, and checks again/);
    assert.equal(await usageStop(env), undefined);
    assert.equal(await usageStop(env), undefined);
  });
  assert.equal(calls(), 3);
});

test("doctor --verify warns that USAGE_CHECK=1 cannot work with a token the usage endpoint answers 403", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-usage-doctor-"));
  const config = join(cwd, "xdg");
  mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
  writeFileSync(join(config, "sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n", { mode: 0o600 });
  // A preload that stubs fetch, through NODE_OPTIONS, so it reaches every process the CLI starts.
  const preload = join(cwd, "stub.mjs");
  writeFileSync(preload, 'globalThis.fetch = async () => new Response("{}", { status: 403 });\n');
  // No host login either: an empty config dir, and a `security` that finds nothing ahead of the real one on a Mac.
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
  const r = runKit(["doctor", "--verify"], {
    cwd,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(cwd, "claude"), NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, XDG_CONFIG_HOME: config, GIT_CEILING_DIRECTORIES: tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  assert.match(r.stdout, /opt\s+CLAUDE_CODE_OAUTH_TOKEN from .*- not checked \(HTTP 403\)/, r.stdout + r.stderr);
  assert.match(r.stdout, /warn USAGE_CHECK=1 cannot work with this token/, r.stdout);
});
