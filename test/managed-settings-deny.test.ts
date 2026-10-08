// The managed Claude Code settings every sandbox gets (container/managed-settings.json, mounted
// read-only at /etc/claude-code): the tools that let an agent wait on a backgrounded suite are
// denied, and the git guard hook is still registered. Sandboxes run with permission prompts off
// (--dangerously-skip-permissions); a deny rule is checked before that mode, and managed settings
// sit above project settings, so a branch cannot lift it.
//
//   pnpm test:file test/managed-settings-deny.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { KIT, MANAGED_SETTINGS, sandboxMounts } from "../src/sandbox.ts";

// The settings file as the sandbox gets it: found through the read-only mount of container/.
const mount = sandboxMounts({ mounts: [] } as unknown as Project).find((m) => m.sandboxPath === MANAGED_SETTINGS);
const settings = JSON.parse(readFileSync(join(mount!.hostPath, "managed-settings.json"), "utf8"));

test("the sandbox's managed settings deny the tools that wait or schedule", () => {
  assert.ok(mount?.readonly, "container/ is mounted read-only");
  const deny: string[] = settings.permissions?.deny ?? [];
  for (const tool of ["Monitor", "ScheduleWakeup", "CronCreate", "RemoteTrigger"]) {
    assert.ok(deny.includes(tool), `${tool} is denied`);
  }
});

test("every deny rule is a bare tool name, so it removes the tool whatever its input", () => {
  for (const rule of settings.permissions.deny as string[]) assert.match(rule, /^[A-Za-z]+$/, rule);
});

test("the git guard stays registered beside the deny rules", () => {
  const hooks = settings.hooks?.PreToolUse ?? [];
  assert.ok(hooks.some((h: { hooks: { command: string }[] }) => h.hooks.some((x) => x.command === `${MANAGED_SETTINGS}/git-guard.sh`)));
  assert.equal(KIT, join(mount!.hostPath, ".."));
});
