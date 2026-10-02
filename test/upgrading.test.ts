// A pulled kit tells each project which Upgrading notes it has not acted on: doctor and a run
// compare the kit's changelog with the project's update record. And the kit version that doctor
// and `--version` print. A made-up kit (in git and out of it) and project in temp directories; no network.
//
//   pnpm exec tsx --test test/upgrading.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// A made-up kit outside git must not find the repository the temp directory may sit in.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const { kitVersion, markUpdated, pendingUpgrades, upgradeLines, upgradingNotes } = await import("../src/upgrading.ts");

const changelog = (unreleased: string[], released: string[]) =>
  "# Changelog\n\n## [Unreleased]\n\n" +
  (unreleased.length ? `### Upgrading\n\n${unreleased.map((n) => `- **${n}** More words.\n`).join("")}\n` : "") +
  "## [0.1.0] - 2026-01-01\n\n### Upgrading\n\n" +
  released.map((n) => `- **${n}** More words,\n  on a second line.\n`).join("") +
  "\n### Fixed\n\n- **Not an upgrading note.**\n";

const plainKit = (text: string) => {
  const kit = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  writeFileSync(join(kit, "package.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(join(kit, "CHANGELOG.md"), text);
  return kit;
};

const kitRepo = () => {
  const kit = plainKit("");
  const git = (...a: string[]) => spawnSync("git", ["-C", kit, ...a], { encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  const commit = (text: string) => {
    writeFileSync(join(kit, "CHANGELOG.md"), text);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "change");
    return git("rev-parse", "HEAD");
  };
  return { kit, git, commit };
};

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-project-"));
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  return root;
};
const record = (root: string) => join(root, ".sandcastle/.run/kit-updated");

test("upgradingNotes reads only the Upgrading sections, by each bullet's bold lead", () => {
  assert.deepEqual(upgradingNotes(changelog(["New default."], ["Old step."])), ["New default.", "Old step."]);
});

test("a project with no record is told to update once; a recorded one hears nothing until the kit moves", () => {
  const { kit, commit } = kitRepo();
  commit(changelog([], ["Old step."]));
  const root = project();
  assert.deepEqual(pendingUpgrades(root, kit), { recorded: false, notes: ["Old step."] });
  assert.match(upgradeLines(root, kit).join("\n"), /no record of a kit update.*\n.*\/sandcastle update/);
  markUpdated(root, kit);
  assert.deepEqual(JSON.parse(readFileSync(record(root), "utf8")), { version: "0.1.0", notes: ["Old step."] });
  assert.deepEqual(upgradeLines(root, kit), []);

  // A pull brings a new note in Unreleased: listed, with the release last recorded, then quiet again once recorded.
  commit(changelog(["The hold label is new."], ["Old step."]));
  assert.deepEqual(pendingUpgrades(root, kit), { recorded: true, since: "0.1.0", notes: ["The hold label is new."] });
  const lines = upgradeLines(root, kit);
  assert.match(lines[0], /^warn The kit has 1 upgrading note.*since its last update \(at 0\.1\.0\):$/);
  assert.equal(lines[1], "       - The hold label is new.");
  assert.match(upgradeLines(root, kit, false)[0], /`sandcastle doctor` lists them/);
  markUpdated(root, kit);

  // The release moves the note from Unreleased into a version: not new again.
  commit(changelog([], ["The hold label is new.", "Old step."]));
  assert.deepEqual(upgradeLines(root, kit), []);
});

test("a kit outside git keeps the record all the same", () => {
  const kit = plainKit(changelog([], ["Old step."]));
  const root = project();
  assert.equal(pendingUpgrades(root, kit).recorded, false);
  assert.equal(markUpdated(root, kit), "0.1.0");
  assert.deepEqual(upgradeLines(root, kit), []);
  writeFileSync(join(kit, "CHANGELOG.md"), changelog(["New default."], ["Old step."]));
  assert.deepEqual(pendingUpgrades(root, kit).notes, ["New default."]);
});

test("an older record holding a kit commit is read through git, and counts as none once git cannot", () => {
  const { kit, commit } = kitRepo();
  const old = commit(changelog([], ["Old step."]));
  commit(changelog(["New default."], ["Old step."]));
  const root = project();
  writeFileSync(record(root), `${old}\n`);
  assert.deepEqual(pendingUpgrades(root, kit), { recorded: true, since: undefined, notes: ["New default."] });
  // Read, never rewritten: doctor changes nothing.
  assert.equal(readFileSync(record(root), "utf8"), `${old}\n`);

  writeFileSync(record(root), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(pendingUpgrades(root, kit).recorded, false);
  writeFileSync(record(root), "{ not json");
  assert.equal(pendingUpgrades(root, kit).recorded, false);
});

test("the kit version: the release, and how far a clone is past its tag", () => {
  assert.equal(kitVersion(plainKit("")), "0.1.0");

  const { kit, git, commit } = kitRepo();
  const first = commit("a").slice(0, 7);
  // Bumped but not tagged yet: no distance, which `git describe` would count from an older tag.
  assert.match(kitVersion(kit), new RegExp(`^0\\.1\\.0 \\(${first}`));
  git("tag", "v0.1.0");
  assert.equal(kitVersion(kit), "0.1.0");
  const second = commit("b").slice(0, 7);
  assert.match(kitVersion(kit), new RegExp(`^0\\.1\\.0 \\+1 \\(${second}`));
  assert.ok(!kitVersion(kit).includes("local changes"));
  writeFileSync(join(kit, "CHANGELOG.md"), "edited");
  assert.match(kitVersion(kit), /^0\.1\.0 \+1 \([0-9a-f]+, local changes\)$/);
  // An untracked file is not a local change, as with `git describe --dirty`.
  git("checkout", "-q", "--", "CHANGELOG.md");
  writeFileSync(join(kit, "stray.txt"), "x");
  assert.doesNotMatch(kitVersion(kit), /local changes/);

  // A kit unpacked inside another repository does not report that repository's commit.
  const inner = join(kit, "vendor");
  mkdirSync(inner);
  writeFileSync(join(inner, "package.json"), JSON.stringify({ version: "0.2.0" }));
  assert.equal(kitVersion(inner), "0.2.0");
});

test("package.json's version is the changelog's latest release", () => {
  const kit = join(import.meta.dirname, "..");
  const released = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(join(kit, "CHANGELOG.md"), "utf8"))?.[1];
  assert.equal(JSON.parse(readFileSync(join(kit, "package.json"), "utf8")).version, released, "bump package.json with each release");
});
