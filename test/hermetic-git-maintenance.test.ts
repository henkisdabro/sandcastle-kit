// The test preload (test/hermetic-env.ts) turns git's automatic maintenance off. A commit otherwise ends by
// starting `git maintenance run --auto`, which detaches and holds `.git/objects/maintenance.lock`, so a test
// that lists a fixture repo before and after a step sees the lock in one listing and not the other. Temp repos
// only: no Docker, no network.
//
//   pnpm test:file test/hermetic-git-maintenance.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-hermetic-maintenance-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repo = join(TMP, "repo");
git(TMP, ["init", "-q", "-b", "main", repo]);
git(repo, ["config", "user.name", "Operator Example"]);
git(repo, ["config", "user.email", "operator@example.com"]);
git(repo, ["config", "commit.gpgsign", "false"]);

let n = 0;
/** One commit with GIT_TRACE going to a file; returns the trace. `config` is `-c` pairs placed before `commit`. */
const commitTrace = (config: string[]): string => {
  const trace = join(TMP, `trace-${n}.log`);
  writeFileSync(join(repo, "f.txt"), `${n}\n`);
  git(repo, ["add", "f.txt"]);
  git(repo, [...config, "commit", "-q", "-m", `commit ${n++}`], { ...process.env, GIT_TRACE: trace });
  return readFileSync(trace, "utf8");
};

test("a commit under the test preload starts no git maintenance", () => {
  assert.doesNotMatch(commitTrace([]), /run_command: git maintenance run/);
});

// The control: with the setting on and no detach (so the process has ended when the commit returns), the same
// commit does start it, so the check above can fail.
test("the same commit with maintenance turned back on starts it", () => {
  assert.match(commitTrace(["-c", "maintenance.auto=true", "-c", "maintenance.autoDetach=false"]), /run_command: git maintenance run/);
});
