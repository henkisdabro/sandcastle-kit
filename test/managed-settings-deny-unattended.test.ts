// The managed settings also deny the tools a sandbox's agent cannot use unattended, or that write to
// the shared .git where the git guard's Bash|Write|Edit matcher never looks: EnterWorktree and
// ExitWorktree add and remove a worktree and a branch there.
//
//   pnpm test:file test/managed-settings-deny-unattended.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "../src/sandbox.ts";

const settings = JSON.parse(readFileSync(join(KIT, "container/managed-settings.json"), "utf8"));

test("the sandbox cannot call the worktree, workflow, design-sync or notification tools", () => {
  const deny: string[] = settings.permissions.deny;
  for (const tool of ["EnterWorktree", "ExitWorktree", "Workflow", "DesignSync", "PushNotification"]) {
    assert.ok(deny.includes(tool), `${tool} is denied`);
  }
});

test("the tools the guard's matcher does not cover are the ones denied outright", () => {
  const matcher: string = settings.hooks.PreToolUse[0].matcher;
  for (const tool of ["EnterWorktree", "ExitWorktree"]) {
    assert.ok(!matcher.split("|").includes(tool), `${tool} is not guarded, so only the deny rule stops it`);
    assert.ok(settings.permissions.deny.includes(tool));
  }
});
