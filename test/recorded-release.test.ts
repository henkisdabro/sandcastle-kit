// The release a project last updated at, from its update record: what `/sandcastle update` reports
// as "this project: <recorded release> -> <kit version now>", where the kit's own pre-pull version
// would read the same before and after when another session already pulled the kit. A made-up kit
// and project in temp directories; no network, Docker or model calls.
//
//   pnpm test:file test/recorded-release.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// A made-up kit outside git must not find the repository the temp directory may sit in.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const { markUpdated, recordedRelease, updatedLine } = await import("../src/upgrading.ts");

const kit = (version: string) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
  return dir;
};
const project = (record?: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-project-"));
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  if (record !== undefined) writeFileSync(join(root, ".sandcastle/.run/kit-updated"), record);
  return root;
};

test("the recorded release is the one the project last updated at, not the kit's release now", () => {
  const root = project(JSON.stringify({ version: "0.11.0", notes: [] }));
  assert.equal(recordedRelease(root, kit("0.13.0")), "0.11.0");
});

test("a project with no update record has no recorded release", () => {
  assert.equal(recordedRelease(project(), kit("0.13.0")), undefined);
});

test("an unreadable record, or one that names no release, has no recorded release", () => {
  assert.equal(recordedRelease(project("{not json"), kit("0.13.0")), undefined);
  assert.equal(recordedRelease(project(JSON.stringify({ notes: [] })), kit("0.13.0")), undefined);
});

test("an older record holding a kit commit names the release the kit's package.json had at that commit", () => {
  const dir = kit("0.10.0");
  const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("add", "-A");
  git("commit", "-q", "-m", "0.10.0");
  const old = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.13.0" }));
  git("commit", "-q", "-am", "0.13.0");
  assert.equal(recordedRelease(project(`${old}\n`), dir), "0.10.0");
  // A commit this kit's git does not have is no record at all, as doctor counts it.
  assert.equal(recordedRelease(project("0123456789abcdef0123456789abcdef01234567\n"), dir), undefined);
});

test("the update line names the project's earlier release against the kit now, or says there was none", () => {
  const root = project(JSON.stringify({ version: "0.11.0", notes: [] }));
  const now = kit("0.13.0");
  const before = recordedRelease(root, now);
  assert.equal(
    updatedLine(before, markUpdated(root, now)),
    "Recorded: this project is up to date with sandcastle-kit 0.13.0 (this project: 0.11.0 -> 0.13.0).",
  );
  // Marking replaced the record: the release read afterwards is the new one, so it must be read first.
  assert.equal(recordedRelease(root, now), "0.13.0");
  assert.equal(
    updatedLine(undefined, "0.13.0"),
    "Recorded: this project is up to date with sandcastle-kit 0.13.0 (this project: no earlier record -> 0.13.0).",
  );
});

test("the CLI reads the recorded release before it marks the project updated", () => {
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
  assert.match(cli, /const before = recordedRelease\(root\);\n\s+console\.log\(updatedLine\(before, markUpdated\(root, KIT, declined, accepted\)\)\);/);
});

test("the update skill reports the project's recorded release, not the kit's version before the pull", () => {
  const step = readFileSync(join(import.meta.dirname, "../skill/update.md"), "utf8");
  assert.match(step, /this project: <recorded release> -> <kit version now>/);
  assert.match(step, /no earlier record/);
  assert.doesNotMatch(step, /kit version before and after/);
});
