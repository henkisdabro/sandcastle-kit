// A `core.hooksPath` that does not exist inside a sandbox (an absolute host path, or one that climbs out of the
// worktree) leaves every agent commit without hooks, and the git-hook probe reads `none` as for a project with no
// hooks. Doctor, `lean` and the base check (`sandcastle gates`) each flag it, with the value and the fix.
// Temp repos only; no Docker.
//
//   pnpm test:file test/hooks-path-outside.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { runKit } from "./cli-spawn.ts";

// The kit's config dir is read at import; a test must not touch the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { hooksPathOutside, plan, report } = await import("../src/lean.ts");
const { hooksPathWarning } = await import("../src/gates.ts");

const ABSOLUTE = "/Users/someone/project/.githooks";

const repo = (hooksPath?: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hookspath-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".githooks"));
  writeFileSync(join(root, ".githooks/pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), 'export default { name: "t", tracker: "files", setup: [], gates: [{ name: "ok", command: "true" }] };\n');
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  if (hooksPath !== undefined) git("config", "core.hooksPath", hooksPath);
  return root;
};

test("an absolute or climbing core.hooksPath is outside the sandbox; a relative one in the project is not", () => {
  for (const value of [ABSOLUTE, "~/hooks", "C:\\work\\hooks", "../hooks", "a/../../hooks", "..\\hooks"]) {
    assert.equal(hooksPathOutside(repo(value)), value, value);
  }
  for (const value of [".githooks", ".husky/_", "tools/hooks", "./hooks", "a/../hooks"]) {
    assert.equal(hooksPathOutside(repo(value)), undefined, value);
  }
  assert.equal(hooksPathOutside(repo()), undefined);
});

test("the base check names the value, the fix and the --accept-git-config case", () => {
  const said = hooksPathWarning(repo(ABSOLUTE)).join("\n");
  assert.ok(said.includes(`"${ABSOLUTE}"`), said);
  assert.match(said, /agent commits run none/);
  assert.match(said, /`git config core\.hooksPath <relative path>`/);
  assert.match(said, /--accept-git-config` once/);
  assert.deepEqual(hooksPathWarning(repo(".githooks")), []);
});

test("lean warns about it and no longer says the hooks run", (t) => {
  const log = t.mock.method(console, "log", () => {});
  const project = { name: "fixture", root: repo(ABSOLUTE), lean: { keep: [], dropHooks: [] }, hookTests: [] } as unknown as Project;
  report(project, plan(project));
  const said = log.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(said, /WARNING: core\.hooksPath is "\/Users\/someone\/project\/\.githooks"/);
  assert.doesNotMatch(said, /run on every agent commit/);
});

test("lean still says the hooks run for a relative core.hooksPath", (t) => {
  const log = t.mock.method(console, "log", () => {});
  const project = { name: "fixture", root: repo(".githooks"), lean: { keep: [], dropHooks: [] }, hookTests: [] } as unknown as Project;
  report(project, plan(project));
  const said = log.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(said, /Git hooks \(\.githooks\) run on every agent commit in the sandbox/);
  assert.doesNotMatch(said, /core\.hooksPath is/);
});

test("doctor reports it as a FIX in a project", () => {
  const doctor = (root: string) =>
    runKit(["doctor"], { cwd: root, encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-test-")), GIT_CEILING_DIRECTORIES: tmpdir() } }).stdout;
  assert.match(doctor(repo(ABSOLUTE)), /FIX  core\.hooksPath is "\/Users\/someone\/project\/\.githooks".*\n.*-> .*git config core\.hooksPath <relative path>/);
  assert.doesNotMatch(doctor(repo(".githooks")), /core\.hooksPath is/);
});

test("the base check prints the warning before its cached return", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/gates.ts", import.meta.url), "utf8");
  const start = src.indexOf("export const requireGreenBase");
  const warn = src.indexOf("hooksPathWarning(project.root)", start);
  assert.ok(warn > start && warn < src.indexOf("hooksCovered(project.root, key)", start));
});
