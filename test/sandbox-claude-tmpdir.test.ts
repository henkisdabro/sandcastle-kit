// Every sandbox gets CLAUDE_CODE_TMPDIR under the agent's home, so a project cloned under
// /tmp/claude-<uid>/ (whose mount parents Docker creates as root) cannot crash Claude Code.
// Temp dirs only, no Docker, no network.
//
//   pnpm test:file test/sandbox-claude-tmpdir.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
writeFileSync(join(xdg, "sandcastle-kit", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n");
const { sandboxEnv, CLAUDE_TMPDIR } = await import("../src/sandbox.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const project = { root: mkdtempSync(join(tmpdir(), "sandcastle-tmpdir-")), tracker: fakeTracker() } as unknown as Project;

test("a sandbox's Claude Code temp root is the exported constant", () => {
  assert.equal(typeof CLAUDE_TMPDIR, "string");
  assert.equal(sandboxEnv(project).CLAUDE_CODE_TMPDIR, CLAUDE_TMPDIR);
});

test("the temp root is an absolute path under the agent's home, never under /tmp", () => {
  assert.equal(CLAUDE_TMPDIR, "/home/agent/.claude-tmp");
  assert.ok(CLAUDE_TMPDIR.startsWith("/home/agent/"));
  assert.ok(!CLAUDE_TMPDIR.startsWith("/tmp"));
});
