// The committer of the kit's merges and of a sandbox's commits: the agent, with the
// operator still the author. Temp git repo, no Docker, no gh, no network.
//
//   pnpm exec tsx --test test/committer.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
writeFileSync(join(xdg, "sandcastle-kit", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n");
const { AGENT_COMMITTER, sandboxEnv } = await import("../src/sandbox.ts");
const { mergeBranch } = await import("../src/burndown.ts");
type Project = import("../src/config.ts").Project;

// CI has no global identity, and the developer running this may export a committer of their own.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^GIT_(COMMITTER|AUTHOR)_/.test(k)),
) as Record<string, string>;
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", env: cleanEnv }).trim();

const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-committer-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  return root;
};
const commitFile = (root: string, file: string) => {
  writeFileSync(join(root, file), `${file}\n`);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", `add ${file}`);
};

test("the landing merge is committed by the agent, authored by the operator, and still found by its subject", () => {
  const root = makeRepo();
  commitFile(root, "base.txt");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  commitFile(root, "work.txt");
  const tip = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  commitFile(root, "moved.txt");

  mergeBranch(root, "agent/issue-7", tip, "#7");

  assert.equal(
    git(root, "log", "-1", "--format=%an|%ae|%cn|%ce|%s"),
    "Operator Example|operator@example.com|Sandcastle agent|agent@sandcastle.invalid|Merge agent/issue-7 (closes #7)",
  );
  assert.equal(git(root, "rev-list", "--parents", "-1", "HEAD").split(" ").length, 3, "a merge commit has two parents");
  // The form mergedEarlier and status.sh use to find a landed branch.
  assert.equal(
    git(root, "log", "main", "-1", "--format=%h", "--fixed-strings", "--grep=Merge agent/issue-7 (closes #7)"),
    git(root, "rev-parse", "--short", "HEAD"),
  );
});

test("the sandbox env names the committer, keeps the credentials and sets no author", () => {
  const root = makeRepo();
  const project = { root, tracker: { kind: "github" } } as unknown as Project;
  const env = sandboxEnv(project);
  assert.equal(env.GIT_COMMITTER_NAME, "Sandcastle agent");
  assert.equal(env.GIT_COMMITTER_EMAIL, "agent@sandcastle.invalid");
  assert.equal(env.GH_TOKEN, "github_pat_fake");
  assert.equal("GIT_AUTHOR_NAME" in env, false);
  assert.equal("GIT_AUTHOR_EMAIL" in env, false);
});

test("git reads those env names as the committer and leaves the author to config", () => {
  const root = makeRepo();
  commitFile(root, "base.txt");
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "agent work"], {
    cwd: root,
    env: { ...cleanEnv, ...AGENT_COMMITTER },
  });
  assert.equal(
    git(root, "log", "-1", "--format=%an|%ae|%cn|%ce"),
    "Operator Example|operator@example.com|Sandcastle agent|agent@sandcastle.invalid",
  );
});
