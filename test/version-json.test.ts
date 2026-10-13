// `sandcastle --version --json`: the facts the Claude Code mod's idle mark reads - the kit version, and
// where this project stands against it. Started as a child process in made-up projects under a temp
// directory; the kit is this checkout. No Docker, model or network.
//
//   pnpm test:file test/version-json.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// A made-up kit and project outside git must not find the repository the temp directory may sit in.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const { versionFacts } = await import("../src/upgrading.ts");

const RELEASE = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")).version as string;
const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout.trim();

/** A git repository with a user's `.sandcastle/config.ts` (when `setUp`) and the update record's text (none for no file). */
const project = ({ setUp = true, record }: { setUp?: boolean; record?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-project-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  if (setUp) writeFileSync(join(root, ".sandcastle/config.ts"), "export default {};\n");
  if (record !== undefined) writeFileSync(join(root, ".sandcastle/.run/kit-updated"), record);
  return root;
};

const facts = (cwd: string) => {
  const r = runKit(["--version", "--json"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("in a set-up project with no update record: the kit's release, no recorded release, every Upgrading note pending", () => {
  const out = facts(project());
  assert.deepEqual(Object.keys(out), ["kit", "newestRelease", "project"]);
  assert.equal(out.kit.release, RELEASE);
  assert.ok(String(out.kit.version).startsWith(RELEASE), out.kit.version);
  assert.equal(typeof out.kit.past, "number");
  assert.equal(out.newestRelease, null);
  assert.equal(out.project.recorded, false);
  assert.equal(out.project.release, null);
  assert.ok(out.project.pendingNotes.length > 0 && out.project.pendingNotes.every((n: unknown) => typeof n === "string"));
});

test("outside a set-up project the project is null: no repository, a repository with no config.ts", () => {
  assert.equal(facts(mkdtempSync(join(tmpdir(), "sandcastle-plain-"))).project, null);
  assert.equal(facts(project({ setUp: false })).project, null);
  assert.equal(facts(mkdtempSync(join(tmpdir(), "sandcastle-plain-"))).kit.release, RELEASE);
});

test("a subdirectory of a set-up project reads the project at its git root", () => {
  const root = project();
  mkdirSync(join(root, "src/deep"), { recursive: true });
  assert.equal(facts(join(root, "src/deep")).project.recorded, false);
});

test("a project that ran `sandcastle updated` is recorded at the kit's release with nothing pending", () => {
  const root = project();
  const r = runKit(["updated"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(facts(root).project, { recorded: true, release: RELEASE, pendingNotes: [] });
});

test("a record at an earlier release names it, and the notes it has not had are pending", () => {
  const out = facts(project({ record: JSON.stringify({ version: "0.1.0", notes: [] }) })).project;
  assert.equal(out.recorded, true);
  assert.equal(out.release, "0.1.0");
  assert.ok(out.pendingNotes.length > 0);
});

test("a usable record that names no release is recorded with a null release", () => {
  const out = facts(project({ record: JSON.stringify({ notes: [] }) })).project;
  assert.equal(out.recorded, true);
  assert.equal(out.release, null);
});

test("an unreadable record, or an old one whose commit this kit cannot read, is not recorded", () => {
  for (const record of ["{not json", "0123456789abcdef0123456789abcdef01234567\n", "{}"]) {
    const out = facts(project({ record })).project;
    assert.equal(out.recorded, false, record);
    assert.equal(out.release, null, record);
  }
});

test("plain --version prints the one line it always did, with no JSON", () => {
  const r = runKit(["--version"], { cwd: project(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^sandcastle-kit ${RELEASE.replaceAll(".", "\\.")}( .*)?\\n$`));
});

test("a clone past its release's tag reports how far past, and a kit exactly at it reports none", () => {
  const kit = mkdtempSync(join(tmpdir(), "sandcastle-kit-"));
  writeFileSync(join(kit, "package.json"), JSON.stringify({ version: "0.9.0" }));
  writeFileSync(join(kit, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
  git(kit, "init", "-q", "-b", "main");
  git(kit, "config", "user.name", "Test");
  git(kit, "config", "user.email", "test@example.com");
  git(kit, "add", "-A");
  git(kit, "commit", "-q", "-m", "release 0.9.0");
  git(kit, "tag", "v0.9.0");
  assert.deepEqual(versionFacts(undefined, kit).kit, { version: "0.9.0", release: "0.9.0", past: 0 });
  git(kit, "commit", "-q", "--allow-empty", "-m", "one");
  git(kit, "commit", "-q", "--allow-empty", "-m", "two");
  const out = versionFacts(undefined, kit).kit;
  assert.equal(out.release, "0.9.0");
  assert.equal(out.past, 2);
  assert.match(out.version, /^0\.9\.0 \+2 \([0-9a-f]+\)$/);
});
