// burndown's scratch removal must precede lockRun's exit listener: another run may take the project as soon as
// that listener releases its lock. Run the actual registration from burndown in a child (burndown itself needs
// Docker), over a real scratch worktree and the real cleanup helper. A fake docker observes the lock during removal.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runNode } from "./cli-spawn.ts";

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));

test("the run keeps its project lock until its exit has removed its own scratch worktree", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-scratch-lock-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Example", "-c", "user.email=example@example.com", "commit", "-q", "--allow-empty", "-m", "base");
  const scratch = join(root, ".sandcastle/worktrees/sandcastle-base-gates-1");
  git("worktree", "add", "-q", "-b", "sandcastle/base-gates-1", scratch);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/bin/sh
if [ ! -f "$REPO/.sandcastle/logs/run.lock" ]; then
  echo unlocked > "$REPO/cleanup-without-lock"
fi
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
  // Keep this wiring tied to the real call site, as the signal test does for the cleanup's fingerprint and guard flag.
  const source = readFileSync(join(KIT, "src/burndown.ts"), "utf8");
  const registration = source.match(/if \(!unlockOnExit\) process\.\w+\("exit", \(\) => exitScratch\?\.\(\)\);/)?.[0];
  assert.ok(registration, "burndown's scratch exit registration");
  const fixture = join(root, "exit.mts");
  writeFileSync(fixture, `
import { lockRun, gitFingerprint, assertGitUnchanged, removeOwnScratchOnExit } from ${JSON.stringify(join(KIT, "src/guard.ts"))};
import { recordScratchWorktree } from ${JSON.stringify(join(KIT, "src/sandbox.ts"))};
const project = { root: process.env.REPO!, name: "fixture", baseBranch: "main" };
lockRun(project);
const expected = gitFingerprint(project);
recordScratchWorktree(${JSON.stringify(scratch)});
const unlockOnExit = false;
const exitScratch = () => removeOwnScratchOnExit(project, (when) => assertGitUnchanged(project, expected, when), false);
${registration}
`);
  const result = runNode([fixture], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, REPO: root, PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter) },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(scratch), false, "the scratch worktree was removed");
  assert.equal(existsSync(join(root, "cleanup-without-lock")), false, "cleanup must run before the project lock is released");
  assert.equal(existsSync(join(root, ".sandcastle/logs/run.lock")), false, "the project lock is released after cleanup");
});
