import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runNode } from "./cli-spawn.ts";

const kit = join(import.meta.dirname, "..");

test("all current version fields agree with package.json and the latest changelog release", () => {
  const result = runNode([join(kit, "scripts/version.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("a release synchronises public versions, checks drift and leaves history and dependencies alone", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["scripts", "herdr", "site", "README.md", "package.json", "CHANGELOG.md"]) {
    cpSync(join(kit, path), join(root, path), { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.version = "9.8.7";
  pkg.engines.node = ">=24";
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  const run = (mode: string) => runNode([join(root, "scripts/version.mjs"), mode], { encoding: "utf8" });
  const stale = run("--check");
  assert.equal(stale.status, 1);
  for (const path of ["herdr/herdr-plugin.toml", "site/index.html", "README.md", "CHANGELOG.md"]) assert.ok(stale.stderr.includes(path), stale.stderr);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  writeFileSync(join(root, "CHANGELOG.md"), changelog.replace("## [Unreleased]", "## [Unreleased]\n\n## [9.8.7] - 2026-10-06"));
  assert.equal(run("--write").status, 0);
  assert.equal(run("--check").status, 0);
  assert.match(readFileSync(join(root, "site/index.html"), "utf8"), /<span data-version>v9\.8\.7<\/span>/);
  assert.match(readFileSync(join(root, "site/index.html"), "utf8"), /"softwareVersion": "9\.8\.7"/);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /badge\/release-v9\.8\.7-/);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /badge\/node-24%2B-/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), pkg);
  assert.ok(readFileSync(join(root, "CHANGELOG.md"), "utf8").includes(changelog.slice(changelog.indexOf("## [0."))));

  const bump = spawnSync("pnpm", ["--dir", root, "version", "9.8.8", "--no-git-tag-version", "--no-git-checks"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(bump.status, 0, bump.stderr);
  assert.match(readFileSync(join(root, "site/index.html"), "utf8"), /<span data-version>v9\.8\.8<\/span>/);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /badge\/release-v9\.8\.8-/);

  // A manual edit is caught, and a renamed marker fails before any file is written.
  const manifest = readFileSync(join(root, "herdr/herdr-plugin.toml"), "utf8");
  writeFileSync(join(root, "herdr/herdr-plugin.toml"), manifest.replace('version = "9.8.8"', 'version = "1.2.3"'));
  assert.equal(run("--check").status, 1);
  const site = readFileSync(join(root, "site/index.html"), "utf8");
  writeFileSync(join(root, "site/index.html"), site.replace("data-version", "data-renamed"));
  const missing = run("--write");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing version field/);
  assert.match(readFileSync(join(root, "herdr/herdr-plugin.toml"), "utf8"), /^version = "1\.2\.3"$/m);
});

test("Pages validates committed versions from main and deploys when a version source changes", () => {
  const workflow = readFileSync(join(kit, ".github/workflows/pages.yml"), "utf8");
  assert.match(workflow, /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+ref: main/);
  assert.match(workflow, /run: node scripts\/version\.mjs --check/);
  assert.doesNotMatch(workflow, /git describe|sed .*data-version/);
  for (const path of ["package.json", "README.md", "CHANGELOG.md", "herdr/herdr-plugin.toml", "scripts/version.mjs"]) {
    assert.ok(workflow.includes(`- '${path}'`), `${path} must trigger deployment`);
  }
});
