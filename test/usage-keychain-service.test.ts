// With CLAUDE_CONFIG_DIR set, Claude Code keeps its macOS login under `Claude Code-credentials-<h>`, <h>
// being the first 8 hex characters of the SHA-256 of the value (a trailing slash removed): the guard
// must look that name up, or it finds nothing and falls back to a token the endpoint answers 403.
// The `security` tool is faked on PATH; no real keychain, network or model calls.
//
//   pnpm exec tsx --test test/usage-keychain-service.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-usage-keychain-xdg-"));
const { hostLoginReaders, keychainService, loginLocation } = await import("../src/usage.ts");

test("an unset or empty CLAUDE_CONFIG_DIR reads the unsuffixed service", () => {
  assert.equal(keychainService(undefined), "Claude Code-credentials");
  assert.equal(keychainService(""), "Claude Code-credentials");
});

test("a set CLAUDE_CONFIG_DIR reads the service suffixed with its hash, a trailing slash removed first", () => {
  // The suffix is the first 8 hex of `printf %s /home/user/claude-alt | sha256sum`.
  assert.equal(keychainService("/home/user/claude-alt"), "Claude Code-credentials-206758aa");
  assert.equal(keychainService("/home/user/claude-alt/"), "Claude Code-credentials-206758aa");
});

test("the real keychain reader asks `security` for that service, and doctor names it", () => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-usage-keychain-bin-"));
  const log = join(bin, "args.log");
  writeFileSync(join(bin, "security"), `#!/bin/sh\necho "$@" >> '${log}'\nexit 44\n`);
  chmodSync(join(bin, "security"), 0o755);
  const before = { path: process.env.PATH, dir: process.env.CLAUDE_CONFIG_DIR };
  try {
    process.env.PATH = `${bin}${delimiter}${before.path}`;
    process.env.CLAUDE_CONFIG_DIR = "/home/user/claude-alt/";
    assert.equal(hostLoginReaders.keychain(), undefined);
    assert.equal(loginLocation("darwin"), 'keychain service "Claude Code-credentials-206758aa"');
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(hostLoginReaders.keychain(), undefined);
    assert.equal(loginLocation("darwin"), 'keychain service "Claude Code-credentials"');
  } finally {
    process.env.PATH = before.path;
    if (before.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before.dir;
  }
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "find-generic-password -s Claude Code-credentials-206758aa -w",
    "find-generic-password -s Claude Code-credentials -w",
  ]);
});
