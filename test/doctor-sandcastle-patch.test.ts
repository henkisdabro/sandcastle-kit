// doctor's "kit dependencies installed" holds the installed @ai-hero/sandcastle to the version package.json pins and
// to the kit's pnpm patch: `npm install`, or a `git pull` with no `pnpm install` after it, leaves a dependency that runs
// unpatched (#711, #782) while the directory exists. The probe takes the kit's directory, so a fake one stands in; the
// real install must pass it. No Docker, model or network.
//
//   pnpm test:file test/doctor-sandcastle-patch.test.ts

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { sandcastlePatchProblems } = await import("../src/sandbox.ts");

const realDist = join(KIT, "node_modules", "@ai-hero", "sandcastle", "dist");
const pinned = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).dependencies["@ai-hero/sandcastle"] as string;

/** A kit directory holding the real installed dist, with `edit` applied to each module's text and `version` installed. */
const fakeKit = (edit: (text: string) => string = (t) => t, version = pinned) => {
  const kit = mkdtempSync(join(tmpdir(), "sandcastle-patch-kit-"));
  const pkg = join(kit, "node_modules", "@ai-hero", "sandcastle");
  mkdirSync(pkg, { recursive: true });
  cpSync(realDist, join(pkg, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
  for (const file of readdirSync(join(pkg, "dist")).filter((f) => f.endsWith(".js"))) {
    const path = join(pkg, "dist", file);
    writeFileSync(path, edit(readFileSync(path, "utf8")));
  }
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@ai-hero/sandcastle", version }));
  writeFileSync(join(kit, "package.json"), JSON.stringify({ dependencies: { "@ai-hero/sandcastle": pinned } }));
  return kit;
};

test("the kit's own install passes: the pinned version, patched", () => {
  assert.deepEqual(sandcastlePatchProblems(), []);
  assert.deepEqual(sandcastlePatchProblems(fakeKit()), []);
});

test("a reuse path that refreshes from origin is the patch not applied (#711)", () => {
  const kit = fakeKit((t) => t.replace(/\) : Effect_exports\.void; \/\/ sandcastle-kit patch \(#711\)[^\n]*/, ") : fastForwardFromOrigin(collision.path, branch);"));
  assert.deepEqual(sandcastlePatchProblems(kit), ["the kit's patch is not applied: a sandbox open refreshes its branch from origin (#711)"]);
});

test("a createSandbox that prunes worktrees itself is the patch not applied (#711)", () => {
  const kit = fakeKit((t) => t.replace(/ *\/\/ sandcastle-kit patch \(#711\): the kit prunes[^\n]*\n/, "      yield* pruneStale(hostRepoDir2).pipe(Effect_exports.catchAll(() => Effect_exports.void));\n"));
  assert.deepEqual(sandcastlePatchProblems(kit), ["the kit's patch is not applied: a sandbox open prunes worktrees outside the kit's lock (#711)"]);
});

test("a 30 s prompt expansion limit is the patch not applied (#782)", () => {
  const kit = fakeKit((t) => t.replace(/PROMPT_EXPANSION_TIMEOUT_MS = 12e4;/, "PROMPT_EXPANSION_TIMEOUT_MS = 3e4;"));
  assert.deepEqual(sandcastlePatchProblems(kit), ["the kit's patch is not applied: a prompt's shell expression has 30 s, too short for gh-retry.sh (#782)"]);
});

test("another installed version than the pinned one names both", () => {
  assert.deepEqual(sandcastlePatchProblems(fakeKit(undefined, "0.12.0")), [`@ai-hero/sandcastle 0.12.0 is installed, the kit pins ${pinned}`]);
});

test("a dist it cannot find its anchors in names the patch, and none installed says so, without a throw", () => {
  const kit = fakeKit(() => "");
  assert.equal(sandcastlePatchProblems(kit).length, 3);
  assert.deepEqual(sandcastlePatchProblems(mkdtempSync(join(tmpdir(), "sandcastle-patch-none-"))), ["@ai-hero/sandcastle is not installed"]);
});
