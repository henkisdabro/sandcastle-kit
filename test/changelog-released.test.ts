// A released version's CHANGELOG.md section equals the one in its tag. A pull request cut before a
// release can land its lines under the released heading after a "keep both" conflict resolution,
// and every other gate passes; a tag comparison catches it however old the branch was. Needs the
// tags (CI checks out with fetch-depth 0; a sandbox's worktree shares the host's .git). No Docker,
// model or network.
//
//   node --test test/changelog-released.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isWorkTreeRoot, releaseTags, releasedSectionProblems } from "./released-changelog.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every released version's section of CHANGELOG.md equals its tag's", (t) => {
  if (!isWorkTreeRoot(root)) return t.skip("not a git work tree (a copy without .git): no tags to compare with");
  // CI must have the tags (a shallow checkout would pass with nothing compared); a copy of the files in a fresh
  // repository outside CI, as full-check's Linux leg makes, has no history to compare with.
  if (!releaseTags(root).length && !process.env.CI) return t.skip("no vX.Y.Z tag here and not CI: nothing to compare with");
  assert.notEqual(releaseTags(root).length, 0, "no vX.Y.Z tag in this repository: fetch them (`git fetch --tags`; in CI, actions/checkout needs fetch-depth: 0)");
  const problems = releasedSectionProblems(root, "CHANGELOG.md", readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  assert.deepEqual(problems, [], `a released section changed after its tag:\n${problems.join("\n")}`);
});

// A repository with a tagged release and a link block after its section, as the real file has.
const released = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [1.2.3] - 2026-01-01",
  "",
  "### Added",
  "",
  "- the first thing",
  "",
  "## [1.2.2] - 2025-12-01",
  "",
  "- an older thing",
  "",
  "[Unreleased]: https://example.invalid/compare/v1.2.3...HEAD",
  "[1.2.3]: https://example.invalid/compare/v1.2.2...v1.2.3",
  "",
].join("\n");

const repo = (): { dir: string; commit: (text: string) => void; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "CHANGELOG.md"), released);
  git("add", ".");
  git("commit", "-q", "-m", "release");
  git("tag", "v1.2.3");
  git("tag", "v1.2.2");
  git("tag", "not-a-release");
  return { dir, commit: (text) => writeFileSync(join(dir, "CHANGELOG.md"), text), done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("a line added under the released heading fails, naming the version and the line", (t) => {
  const r = repo();
  t.after(r.done);
  r.commit(released.replace("- the first thing\n", "- the first thing\n- a late arrival\n"));
  const problems = releasedSectionProblems(r.dir, "CHANGELOG.md", readFileSync(join(r.dir, "CHANGELOG.md"), "utf8"));
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /^1\.2\.3: line 6 of its section differs from v1\.2\.3/);
  assert.match(problems[0], /a late arrival/);
});

test("lines under Unreleased, a new section and the link block do not count as a change", (t) => {
  const r = repo();
  t.after(r.done);
  const next = released
    .replace("## [Unreleased]\n", "## [Unreleased]\n\n- a pending thing\n\n## [1.3.0] - 2026-02-01\n\n- newer\n")
    .replace("[1.2.3]:", "[1.3.0]: https://example.invalid/compare/v1.2.3...v1.3.0\n[1.2.3]:");
  r.commit(next);
  assert.deepEqual(releasedSectionProblems(r.dir, "CHANGELOG.md", next), []);
});

test("a line removed from an older released section fails too", (t) => {
  const r = repo();
  t.after(r.done);
  const problems = releasedSectionProblems(r.dir, "CHANGELOG.md", released.replace("- an older thing\n", ""));
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /^1\.2\.2: /);
});

test("a released section that was removed from the file fails", (t) => {
  const r = repo();
  t.after(r.done);
  const problems = releasedSectionProblems(r.dir, "CHANGELOG.md", released.replace("## [1.2.2]", "## [1.2.1]"));
  assert.match(problems.join("\n"), /1\.2\.2: .*no "## \[1\.2\.2\]" section/);
});

test("a directory that is not a work tree of its own is told apart from one", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(isWorkTreeRoot(dir), false);
  const r = repo();
  t.after(r.done);
  assert.equal(isWorkTreeRoot(r.dir), true);
  assert.deepEqual(releaseTags(r.dir), ["v1.2.2", "v1.2.3"]);
});
