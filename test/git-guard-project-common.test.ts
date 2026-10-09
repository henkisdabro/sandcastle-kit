// The git guard's file-write and rm/mv rules refuse the project's shared .git whatever the hook's cwd:
// the shell's cwd moves with a `cd`, so inside a scratch repository the cwd's own common dir is the
// scratch's, and from a dir in no repository there is none. CLAUDE_PROJECT_DIR names the project.
//
//   pnpm test:file test/git-guard-project-common.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT } from "../src/sandbox.ts";

const GUARD = join(KIT, "container/git-guard.sh");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && k !== "CLAUDE_PROJECT_DIR"));

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-git-guard-common-")));
after(() => rmSync(root, { recursive: true, force: true }));
const main = join(root, "main");
const worktree = join(root, "agent-1");
const scratch = join(root, "scratch");
const nowhere = join(root, "no-repo");
for (const dir of [main, scratch, nowhere]) mkdirSync(dir);
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
git(main, "init", "-q", "-b", "main");
git(main, "commit", "-q", "--allow-empty", "-m", "start");
git(main, "worktree", "add", "-q", "-b", "agent/issue-1", worktree);
git(scratch, "init", "-q", "-b", "main");
const shared = join(main, ".git");

const run = (tool_input: object, cwd: string, projectDir: string | null = worktree) =>
  spawnSync("bash", [GUARD], {
    input: JSON.stringify({ cwd, tool_input }),
    encoding: "utf8",
    env: projectDir === null ? env : { ...env, CLAUDE_PROJECT_DIR: projectDir },
  });

for (const [label, cwd] of [["the worktree", worktree], ["a scratch repo", scratch], ["a dir in no repo", nowhere]] as const) {
  test(`a file write into the shared .git is refused from ${label}`, () => {
    for (const file_path of [join(shared, "worktrees", "agent-1", "HEAD"), join(shared, "config")]) {
      const r = run({ file_path }, cwd);
      assert.equal(r.status, 2, `${file_path}\n${r.stderr}`);
      assert.match(r.stderr, /^BLOCKED: writing inside the shared \.git\./);
    }
  });

  test(`rm and mv inside the shared .git are refused from ${label}`, () => {
    for (const command of [`rm -rf ${shared}/worktrees/agent-1`, `cd ${scratch} && mv ${shared}/HEAD ${root}/HEAD.bak`]) {
      const r = run({ command }, cwd);
      assert.equal(r.status, 2, `${command}\n${r.stderr}`);
      assert.match(r.stderr, /^BLOCKED: rm or mv inside the shared \.git\./);
    }
  });

  test(`a file write and an rm in a scratch repo still pass from ${label}`, () => {
    assert.equal(run({ file_path: join(root, "notes.txt") }, cwd).status, 0);
    assert.equal(run({ file_path: join(scratch, "file.txt") }, cwd).status, 0);
    assert.equal(run({ command: `rm -rf ${scratch}/file.txt ${root}/notes.txt` }, cwd).status, 0);
  });
}

test("without CLAUDE_PROJECT_DIR the cwd's own common dir still guards the write", () => {
  const r = run({ file_path: join(shared, "config") }, worktree, null);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^BLOCKED: writing inside the shared \.git\./);
});
