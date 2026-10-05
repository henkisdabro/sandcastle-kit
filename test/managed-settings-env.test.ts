// The managed Claude Code settings every sandbox gets (container/managed-settings.json, mounted
// read-only at /etc/claude-code): a Bash command run without an explicit `timeout` stays in the
// foreground for as long as a suite takes. Claude Code's 2-minute default moves a longer command to
// the background; an agent that cannot see the suite finish refuses to claim the gates green, ends
// without COMPLETE, and costs the run a second implement session.
//
//   pnpm exec tsx --test test/managed-settings-env.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { KIT, MANAGED_SETTINGS, sandboxMounts } from "../src/sandbox.ts";

// The settings file as the sandbox gets it: found through the read-only mount of container/.
const mount = sandboxMounts({ mounts: [] } as unknown as Project).find((m) => m.sandboxPath === MANAGED_SETTINGS);
const env: Record<string, unknown> = JSON.parse(readFileSync(join(mount!.hostPath, "managed-settings.json"), "utf8")).env ?? {};

// The `timeout` the prompts tell an agent to pass to a gate run, in milliseconds.
const PROMPTED_TIMEOUT_MS = 600_000;

// Claude Code reads an env value from settings as a string.
const ms = (name: string) => Number(env[name]);

test("a Bash command run without a timeout may take at least ten minutes", () => {
  assert.equal(typeof env.BASH_DEFAULT_TIMEOUT_MS, "string", "settings env values are strings");
  assert.ok(ms("BASH_DEFAULT_TIMEOUT_MS") >= PROMPTED_TIMEOUT_MS, `${env.BASH_DEFAULT_TIMEOUT_MS} ms`);
});

test("the maximum a command may ask for is not below the default, so the default is not clamped", () => {
  assert.ok(ms("BASH_MAX_TIMEOUT_MS") >= ms("BASH_DEFAULT_TIMEOUT_MS"), `${env.BASH_MAX_TIMEOUT_MS} ms`);
});

test("the prompts still tell an agent to pass a long timeout, and it fits the maximum", () => {
  for (const name of ["implement", "review", "repair", "resolve"]) {
    const prompt = readFileSync(join(KIT, "prompts", `${name}.md`), "utf8");
    assert.ok(prompt.includes(`timeout: ${PROMPTED_TIMEOUT_MS}`), `${name}.md names timeout: ${PROMPTED_TIMEOUT_MS}`);
  }
  assert.ok(PROMPTED_TIMEOUT_MS <= ms("BASH_MAX_TIMEOUT_MS"));
});
