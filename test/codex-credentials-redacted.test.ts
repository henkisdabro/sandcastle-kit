// With CROSS_REVIEW=1 the host's Codex login is mounted into the sandboxes; its tokens must be
// redacted from a crashed agent's log and note like the kit's own.
//
//   pnpm test:file test/codex-credentials-redacted.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";

// Read at import: the flag, and the home the login is read from.
process.env.CROSS_REVIEW = "1";
const home = mkdtempSync(join(tmpdir(), "sandcastle-codexhome-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { sandboxMounts } = await import("../src/sandbox.ts");
const { redact } = await import("../src/worktree-lock.ts");

const project = { mounts: [] } as unknown as Project;
const authFile = join(home, ".codex", "auth.json");
mkdirSync(join(home, ".codex"));

test("every token of Codex's login, nested ones too, is redacted once the mount is decided", () => {
  writeFileSync(
    authFile,
    JSON.stringify({
      OPENAI_API_KEY: "sk-made-up-top-level-key-1111",
      tokens: { id_token: "made-up-id-token-2222", access_token: "made-up-access-token-3333", deep: { refresh_token: "made-up-refresh-4444" } },
      last_refresh: "2026-01-01T00:00:00Z",
      list: ["made-up-list-entry-5555"],
    }),
  );
  sandboxMounts(project);
  const out = redact(
    "crash: sk-made-up-top-level-key-1111 made-up-id-token-2222 made-up-access-token-3333 made-up-refresh-4444 made-up-list-entry-5555",
  );
  assert.equal(out, "crash: <redacted> <redacted> <redacted> <redacted> <redacted>");
});

test("a malformed login throws nothing and the mount is still made", () => {
  writeFileSync(authFile, "{ not json");
  const mounts = sandboxMounts(project);
  assert.ok(mounts.some((m) => m.sandboxPath === "/home/agent/.codex-host/auth.json"));
});

test("a missing login throws nothing and the mount is still made", () => {
  rmSync(authFile);
  const mounts = sandboxMounts(project);
  assert.ok(mounts.some((m) => m.hostPath === "~/.codex/auth.json"));
});

// A directory where the file should be cannot be read, even by root (chmod 000 can be).
test("an unreadable login throws nothing and the mount is still made", () => {
  mkdirSync(authFile);
  try {
    const mounts = sandboxMounts(project);
    assert.ok(mounts.some((m) => m.hostPath === "~/.codex/auth.json"));
  } finally {
    rmSync(authFile, { recursive: true });
  }
});
