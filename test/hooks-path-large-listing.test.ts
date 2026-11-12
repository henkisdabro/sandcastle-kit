// A tracked hooks directory is found however many files its tracked parent lists: `trackedHooksPath` lists each
// prefix of the path with `git ls-files`, and a listing over Node's default 1 MiB output buffer used to read as "not
// tracked" - the sandboxes' pin, the start's own-tooling check and the protected hooks directory all lost it. Temp
// repos only; no Docker.
//
//   pnpm test:file test/hooks-path-large-listing.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pinnedHooksPath, trackedHooksPath } from "../src/hooks-path.ts";

test("a hooks directory under a tracked parent whose listing passes 1 MiB is still tracked, and pinned", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-hooks-large-")));
  const git = (args: string[], input?: string) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  git(["init", "-q", "-b", "main"]);
  // `hooks/_` itself holds no tracked file (husky's `.husky/_` shape): only the listing of `hooks/` can show it tracked.
  mkdirSync(join(root, "hooks", "_"), { recursive: true });
  writeFileSync(join(root, "hooks", "_", "pre-commit"), "#!/bin/sh\n");
  const blob = git(["hash-object", "-w", "--stdin"], "x\n").trim();
  // Index entries only (no files on disk): ls-files lists the index, and 6,000 names of 200 characters pass 1 MiB.
  const name = "n".repeat(190);
  const lines = Array.from({ length: 6000 }, (_, i) => `100644 ${blob}\thooks/${name}${String(i).padStart(5, "0")}\n`).join("");
  git(["update-index", "--add", "--index-info"], lines);
  assert.ok(trackedHooksPath(root, "hooks/_"));
  git(["config", "core.hooksPath", join(root, "hooks", "_")]);
  assert.equal(pinnedHooksPath(root), "hooks/_");
});
