// Sandcastle's `createSandbox` runs a host worktree prune and an orphan-directory sweep before it creates a sandbox,
// outside the host-git mutex. The pnpm patch (patches/, `patchedDependencies` in pnpm-workspace.yaml) removes the call:
// the kit prunes itself, inside the mutex (`pruneWorktrees` in src/guard.ts). This reads the installed dist, so an
// upgrade that drops the patch fails here.
//
//   pnpm test:file test/sandcastle-open-no-prune.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

const dist = join(KIT, "node_modules", "@ai-hero", "sandcastle", "dist");

/** The text of Sandcastle's `createSandbox`: from its declaration to the first call of `create`. */
const openPath = (): string => {
  for (const file of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(dist, file), "utf8");
    const start = text.indexOf("var createSandbox = async (options) =>");
    if (start === -1) continue;
    const end = text.indexOf("yield* create(", start);
    assert.ok(end > start, `${file}: createSandbox no longer calls create where this test looks; read it again and update the test`);
    return text.slice(start, end);
  }
  throw new Error("Sandcastle's createSandbox was not found in its dist; read it again and update the test");
};

test("opening a sandbox never prunes worktrees in Sandcastle's own code, outside the host-git mutex", () => {
  const code = openPath();
  assert.match(code, /resolveCwd/, "the slice is Sandcastle's createSandbox");
  assert.doesNotMatch(
    code,
    /pruneStale\s*\(/,
    "createSandbox calls pruneStale: the pnpm patch for #711 is not applied (run pnpm install, and re-make the patch on an upgrade)",
  );
});
