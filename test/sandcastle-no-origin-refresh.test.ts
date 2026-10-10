// Sandcastle's worktree create reuses the worktree the kit has just added (under the host-git mutex) and, unpatched,
// refreshes it from origin: a host `git fetch origin <branch>` and a fast-forward outside the mutex, with a 30 s limit
// that an unreachable origin spends on every sandbox open. The pnpm patch (patches/, `patchedDependencies` in
// pnpm-workspace.yaml) removes the call; this reads the installed dist, so an upgrade that drops the patch fails here.
//
//   pnpm test:file test/sandcastle-no-origin-refresh.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

const dist = join(KIT, "node_modules", "@ai-hero", "sandcastle", "dist");

/** The text of Sandcastle's `create`: from its declaration to the reuse path's return. */
const reusePath = (): string => {
  for (const file of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(dist, file), "utf8");
    const start = text.indexOf("var create = (repoDir, opts)");
    if (start === -1) continue;
    const end = text.indexOf("return { path: normalize(collision.path), branch };", start);
    assert.ok(end > start, `${file}: the reuse path no longer ends where this test looks; read it again and update the test`);
    return text.slice(start, end);
  }
  throw new Error("Sandcastle's create was not found in its dist; read it again and update the test");
};

test("opening a sandbox on the worktree the kit added never refreshes the branch from origin", () => {
  const code = reusePath();
  assert.match(code, /collision/, "the slice is Sandcastle's create, reusing a colliding worktree");
  assert.doesNotMatch(
    code,
    /fastForwardFromOrigin\s*\(/,
    "the reuse path calls fastForwardFromOrigin: the pnpm patch for #711 is not applied (run pnpm install, and re-make the patch on an upgrade)",
  );
});

test("the patch is declared in the workspace settings", () => {
  const settings = readFileSync(join(KIT, "pnpm-workspace.yaml"), "utf8");
  assert.match(settings, /patchedDependencies:\s*\n\s+'@ai-hero\/sandcastle@[\d.]+': patches\/@ai-hero__sandcastle@[\d.]+\.patch/);
});
