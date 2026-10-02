// A pulled kit tells each project which Upgrading notes it has not acted on: doctor and a run
// compare the changelog at the kit commit the project last recorded with the kit's own. A made-up
// kit repo and project in temp directories; no network.
//
//   pnpm exec tsx --test test/upgrading.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { markUpdated, pendingUpgrades, upgradeLines, upgradingNotes } = await import("../src/upgrading.ts");

const changelog = (unreleased: string[], released: string[]) =>
  "# Changelog\n\n## [Unreleased]\n\n" +
  (unreleased.length ? `### Upgrading\n\n${unreleased.map((n) => `- **${n}** More words.\n`).join("")}\n` : "") +
  "## [0.1.0] - 2026-01-01\n\n### Upgrading\n\n" +
  released.map((n) => `- **${n}** More words,\n  on a second line.\n`).join("") +
  "\n### Fixed\n\n- **Not an upgrading note.**\n";

const kitRepo = () => {
  const kit = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  const git = (...a: string[]) => spawnSync("git", ["-C", kit, ...a], { encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  const commit = (text: string) => {
    writeFileSync(join(kit, "CHANGELOG.md"), text);
    git("add", "-A");
    git("commit", "-q", "-m", "change");
  };
  return { kit, commit };
};

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-project-"));
  mkdirSync(join(root, ".sandcastle"));
  return root;
};

test("upgradingNotes reads only the Upgrading sections, by each bullet's bold lead", () => {
  assert.deepEqual(upgradingNotes(changelog(["New default."], ["Old step."])), ["New default.", "Old step."]);
});

test("a project with no record is told to update once; a recorded one hears nothing until the kit moves", () => {
  const { kit, commit } = kitRepo();
  commit(changelog([], ["Old step."]));
  const root = project();
  assert.deepEqual(pendingUpgrades(root, kit), { recorded: false, notes: ["Old step."] });
  assert.match(upgradeLines(root, kit).join("\n"), /no record of a kit update.*\n.*\/sandcastle update/);
  assert.ok(markUpdated(root, kit));
  assert.deepEqual(upgradeLines(root, kit), []);

  // A pull brings a new note in Unreleased: listed, then quiet again once recorded.
  commit(changelog(["The hold label is new."], ["Old step."]));
  assert.deepEqual(pendingUpgrades(root, kit), { recorded: true, notes: ["The hold label is new."] });
  const lines = upgradeLines(root, kit);
  assert.match(lines[0], /^warn The kit has 1 upgrading note/);
  assert.equal(lines[1], "       - The hold label is new.");
  assert.match(upgradeLines(root, kit, false)[0], /`sandcastle doctor` lists them/);
  markUpdated(root, kit);

  // The release moves the note from Unreleased into a version: not new again.
  commit(changelog([], ["The hold label is new.", "Old step."]));
  assert.deepEqual(upgradeLines(root, kit), []);
});

test("a recorded commit the kit no longer has counts as no record; a kit outside git says nothing", () => {
  const { kit, commit } = kitRepo();
  commit(changelog([], ["Old step."]));
  const root = project();
  mkdirSync(join(root, ".sandcastle/.run"));
  writeFileSync(join(root, ".sandcastle/.run/kit-updated"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(pendingUpgrades(root, kit)?.recorded, false);

  const plain = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  writeFileSync(join(plain, "CHANGELOG.md"), changelog([], ["Old step."]));
  const outside = { ...process.env };
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  try {
    assert.equal(pendingUpgrades(root, plain), undefined);
    assert.equal(markUpdated(root, plain), undefined);
  } finally {
    process.env = outside;
  }
});
