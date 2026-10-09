// `sandcastle changes`: the CHANGELOG entries after the release a project last updated at (or after
// `--since`), up to the kit's own release, each cut to its bold lead. A made-up kit and project in
// temp directories; no network, Docker or model calls.
//
//   pnpm test:file test/changes.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const { changesLines } = await import("../src/upgrading.ts");

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- **Not released yet.** Left out.

## [0.4.0] - 2026-04-01

### Added

- **Beyond the kit.** A release newer than the kit's own is never shown.

## [0.3.0] - 2026-03-01

### Added

- **A new flag.** It does a thing,
  over two lines.
- Plain entry with no bold lead. A second sentence is dropped.

### Upgrading

- **Rebuild the image.** Run \`sandcastle build\`.

## [0.2.0] - 2026-02-01

### Fixed

- **A bug is gone.**

### Security

- **A hole is closed.** Details.

## [0.1.0] - 2026-01-01

### Changed

- **The first change.**

`;

const kit = (text = CHANGELOG, version = "0.3.0") => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "CHANGELOG.md"), text);
  return dir;
};
const project = (recorded?: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-project-"));
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  if (recorded) writeFileSync(join(root, ".sandcastle/.run/kit-updated"), JSON.stringify({ version: recorded, notes: [] }));
  return root;
};

test("changes from a record lists each later release by section, entries cut to their bold lead", () => {
  assert.deepEqual(changesLines(project("0.1.0"), kit()), [
    "Changes since 0.1.0 (this project's last recorded update), up to 0.3.0:",
    "",
    "## 0.3.0 - 2026-03-01",
    "",
    "### Added",
    "- A new flag.",
    "- Plain entry with no bold lead.",
    "",
    "### Upgrading",
    "- Rebuild the image.",
    "",
    "## 0.2.0 - 2026-02-01",
    "",
    "### Security",
    "- A hole is closed.",
    "",
    "### Fixed",
    "- A bug is gone.",
  ]);
});

test("changes --since counts from the release given, whatever the record says", () => {
  const lines = changesLines(project("0.1.0"), kit(), "v0.2.0");
  assert.equal(lines[0], "Changes since v0.2.0, up to 0.3.0:");
  assert.deepEqual(lines.filter((l) => l.startsWith("## ")), ["## 0.3.0 - 2026-03-01"]);
});

test("changes with no record and no --since says so and prints the current release's entries", () => {
  const lines = changesLines(project(), kit());
  assert.match(lines[0]!, /^This project has no record of a kit update on this machine/);
  assert.deepEqual(lines.filter((l) => l.startsWith("## ")), ["## 0.3.0 - 2026-03-01"]);
  assert.ok(lines.includes("- A new flag."));
  assert.ok(!lines.some((l) => l.includes("Not released yet") || l.includes("Beyond the kit")));
});

test("changes leaves out a section a release has no entries in, and [Unreleased]", () => {
  const lines = changesLines(project("0.0.9"), kit());
  const second = lines.slice(lines.indexOf("## 0.2.0 - 2026-02-01"), lines.indexOf("## 0.1.0 - 2026-01-01"));
  assert.ok(!second.includes("### Added") && !second.includes("### Upgrading"), "0.2.0 has only Security and Fixed");
  assert.ok(second.includes("### Security") && second.includes("### Fixed"));
  assert.ok(!lines.some((l) => l.includes("Not released yet") || l === "## Unreleased"));
});

test("changes says nothing is new when the record is at the kit's release", () => {
  assert.deepEqual(changesLines(project("0.3.0"), kit()), ["Nothing new: the kit is at 0.3.0, and this project's last update was at 0.3.0."]);
});

test("a release with no entries at all is shown as having none", () => {
  const text = "# Changelog\n\n## [0.2.0] - 2026-02-01\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- **Old.**\n";
  assert.deepEqual(changesLines(project("0.1.0"), kit(text, "0.2.0")).slice(1), ["", "## 0.2.0 - 2026-02-01", "", "(no entries)"]);
});

test("sandcastle changes is in the help, `help changes` and `changes --help` print its entry, and a bad --since is refused", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-changes-"));
  const run = (...args: string[]) => runKit(args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
  const all = run("help");
  assert.match(all.stdout, /^ {2}changes \[--since RELEASE\]$/m);
  for (const r of [run("help", "changes"), run("changes", "--help")]) {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}changes \[--since RELEASE\]\n( {4,}\S.*\n?)+$/);
    assert.ok(r.stdout.split("\n").every((l) => l.length <= 90), "help lines fit the terminal");
  }
  spawnSync("git", ["init", "-q", cwd]);
  const bad = run("changes", "--since", "soon");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: sandcastle changes \[--since RELEASE\]/);
});
