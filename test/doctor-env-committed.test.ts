// A project's .sandcastle/.env that is committed (added before its ignore line, or with -f) or not
// ignored at all is a FIX: doctor checked its file mode but not that its tokens were in git.
// A temp repo; doctor's machine checks may fail around it; no network needed for these lines.
//
//   pnpm exec tsx --test test/doctor-env-committed.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const project = (ignore: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-envgit-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: root });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), 'export default { name: "t", tracker: "files", setup: [], gates: [{ name: "ok", command: "true" }] };\n');
  writeFileSync(join(root, ".sandcastle/.gitignore"), ignore);
  writeFileSync(join(root, ".sandcastle/.env"), "EXTRA_KEY=made-up-value\n", { mode: 0o600 });
  return { root, git };
};
const doctor = (root: string) =>
  runKit(["doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-test-")), GIT_CEILING_DIRECTORIES: tmpdir() },
  }).stdout;

test("a committed .sandcastle/.env is a FIX that says to untrack it and rotate its tokens", () => {
  const { root, git } = project(".env\nlogs/\nworktrees/\n");
  git("add", "-f", ".sandcastle/.env");
  git("commit", "-qm", "oops");
  assert.match(doctor(root), /FIX  \.sandcastle\/\.env is committed\n.*`git rm --cached \.sandcastle\/\.env` and commit, then rotate every token in it/);
});

test("an uncommitted .sandcastle/.env that is not ignored is a FIX with the ignore line", () => {
  const { root } = project("logs/\nworktrees/\n");
  assert.match(doctor(root), /FIX  \.sandcastle\/\.env is gitignored\n.*printf '%s\\n' \.env/);
});

test("an ignored, uncommitted .sandcastle/.env says nothing", () => {
  const { root } = project(".env\nlogs/\nworktrees/\n.run/\ntriage/\n");
  assert.doesNotMatch(doctor(root), /FIX  \.sandcastle\/\.env/);
});
