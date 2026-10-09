// A step declined at one release and asked for later is taken off the update record's `declined`
// (`sandcastle updated --accepted KEY`): otherwise the update action kept naming it as declined (#657).
// A made-up kit and project in temp directories; no network.
//
//   pnpm test:file test/upgrading-accepted.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-accepted-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const { declinedSteps, markUpdated } = await import("../src/upgrading.ts");

const kit = (release: string) => {
  const dir = mkdtempSync(join(TMP, "kit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: release }));
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
  return dir;
};
const project = () => {
  const root = mkdtempSync(join(TMP, "project-"));
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  return root;
};

test("an accepted step leaves declined; the others stay", () => {
  const root = project();
  markUpdated(root, kit("0.11.0"), ["claude-mod", "autonomy-drain"]);
  markUpdated(root, kit("0.12.0"), [], ["claude-mod"]);
  assert.deepEqual(declinedSteps(root), { "autonomy-drain": "0.11.0" });
  markUpdated(root, kit("0.12.0"), [], ["autonomy-drain"]);
  assert.equal(JSON.parse(readFileSync(join(root, ".sandcastle/.run/kit-updated"), "utf8")).declined, undefined);
});

test("sandcastle updated takes --declined and --accepted together", () => {
  const root = project();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const run = (...args: string[]) =>
    runKit(["updated", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, XDG_CONFIG_HOME: join(TMP, "config"), XDG_CACHE_HOME: join(TMP, "cache"), GIT_CEILING_DIRECTORIES: tmpdir() },
    });
  assert.equal(run("--declined", "claude-mod,autonomy-drain").status, 0);
  const r = run("--accepted", "claude-mod", "--declined", "hook-tests");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(Object.keys(declinedSteps(root)).sort(), ["autonomy-drain", "hook-tests"]);
  const bad = run("--accepted");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\[--accepted KEY/);
});
