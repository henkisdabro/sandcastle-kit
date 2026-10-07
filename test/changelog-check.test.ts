import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { runNode } from "./cli-spawn.ts";

const script = join(import.meta.dirname, "..", "scripts/changelog-check.mjs");
const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- **First.**\n";

// A repo whose `main` holds a changelog, and a branch off it: each case commits files on the branch.
const repo = (t: TestContext, changelog = CHANGELOG) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-changelog-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: root, stdio: "ignore" });
  const commit = (files: Record<string, string>) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    git("add", "-A");
    git("commit", "-qm", "c");
  };
  git("init", "-q", "-b", "main");
  commit({ "CHANGELOG.md": changelog, "src/a.ts": "a\n" });
  git("switch", "-qc", "branch");
  const check = () => runNode([script, "main"], { cwd: root, encoding: "utf8" });
  return { commit, check };
};

test("a shipped change with no Unreleased line fails and names the files", (t) => {
  const r = repo(t);
  r.commit({ "src/a.ts": "b\n", "test/a.test.ts": "t\n" });
  const result = r.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/a\.ts/);
  assert.doesNotMatch(result.stderr, /test\/a\.test\.ts/);
  assert.match(result.stderr, /no-changelog/);
});

test("a shipped change with a line under Unreleased passes", (t) => {
  const r = repo(t);
  r.commit({ "src/a.ts": "b\n", "CHANGELOG.md": CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- **Second.**\n") });
  assert.equal(r.check().status, 0);
});

test("a changelog edit to a released section alone does not count", (t) => {
  const r = repo(t);
  r.commit({ "src/a.ts": "b\n", "CHANGELOG.md": CHANGELOG.replace("**First.**", "**First, reworded.**") });
  assert.equal(r.check().status, 1);
});

test("a change to tests, docs or CI alone needs no line", (t) => {
  const r = repo(t);
  r.commit({ "test/a.test.ts": "t\n", "docs/a.md": "d\n", ".github/workflows/a.yml": "w\n" });
  assert.equal(r.check().status, 0);
});

test("a release that moves Unreleased under a version heading passes", (t) => {
  const pending = CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- **Second.**\n");
  // Main already holds the line; the release branch moves it and touches a shipped file.
  const r = repo(t, pending);
  const released = pending.replace("## [Unreleased]\n", "## [Unreleased]\n\n## [1.0.1] - 2026-02-01\n");
  r.commit({ "CHANGELOG.md": released, "herdr/herdr-plugin.toml": 'version = "1.0.1"\n' });
  assert.equal(r.check().status, 0);
});
