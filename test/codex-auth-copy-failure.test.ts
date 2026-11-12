// A temp-file failure must never expose the host's refresh token or leave a partial login behind.
// The filesystem is the boundary: simulate a full disk, including a write that fails after creating the file.

import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

process.env.CROSS_REVIEW = "1";
const home = mkdtempSync(join(tmpdir(), "sandcastle-codexfailure-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TMPDIR = home;
const { sandboxMounts, removeCodexAuthCopy } = await import("../src/sandbox.ts");
const project = { mounts: [] } as unknown as Project;
mkdirSync(join(home, ".codex"));
const authFile = join(home, ".codex", "auth.json");
const login = JSON.stringify({ tokens: { access_token: "made-up-access", refresh_token: "made-up-refresh" } });
writeFileSync(authFile, login);
const fullDisk = () => Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

test("a temp-directory failure refuses the sandbox config instead of mounting the host login", (t) => {
  const failure = t.mock.method(fs, "mkdtempSync", () => {
    throw fullDisk();
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => sandboxMounts(project), { code: "ENOSPC" });
    assert.equal(readFileSync(authFile, "utf8"), login);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
    removeCodexAuthCopy();
  }
});

test("a partial auth-file write is removed and never falls back to the host login", (t) => {
  const real = fs.writeFileSync;
  let partial: string | undefined;
  const failure = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof real>) => {
    partial = String(args[0]);
    real(...args);
    throw fullDisk();
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => sandboxMounts(project), { code: "ENOSPC" });
    assert.ok(partial, "the write created the login before failing");
    assert.equal(fs.existsSync(dirname(partial)), false, "the directory and partial login are both removed");
    assert.equal(readFileSync(authFile, "utf8"), login);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
    removeCodexAuthCopy();
  }
  const mount = sandboxMounts(project).find((m) => m.sandboxPath === "/home/agent/.codex-host/auth.json");
  assert.ok(mount);
  assert.equal(JSON.parse(readFileSync(mount.hostPath, "utf8")).tokens.refresh_token, "", "a later attempt can retry safely");
  removeCodexAuthCopy();
});
