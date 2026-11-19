// A project that keeps its tickets in files and has no GitHub remote gets no GH_TOKEN in its sandboxes: nothing there
// needs GitHub, and the run's start has no repository to check the token's push access against. Beside a GitHub
// remote, or with GitHub issues, the token goes in as before. Temp repos only; no Docker, no network.
//
//   pnpm test:file test/sandbox-github-token.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
writeFileSync(join(xdg, "sandcastle-kit", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n");
const { githubRemoteRepo, sandboxEnv } = await import("../src/sandbox.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const repo = (...remotes: [string, string][]) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gh-token-")));
  execFileSync("git", ["init", "-q", root]);
  for (const [name, url] of remotes) execFileSync("git", ["-C", root, "remote", "add", name, url]);
  return root;
};
const project = (root: string, kind: "files" | "github") => ({ root, tracker: fakeTracker({ kind }) }) as unknown as Project;

test("tickets in files with no GitHub remote: the sandboxes get no GH_TOKEN", () => {
  const root = repo(["origin", "https://gitlab.com/o/r.git"]);
  assert.equal(sandboxEnv(project(root, "files")).GH_TOKEN, undefined);
  assert.equal(sandboxEnv(project(repo(), "files")).GH_TOKEN, undefined);
});

test("tickets in files beside a GitHub remote, or GitHub issues, keep GH_TOKEN", () => {
  assert.equal(sandboxEnv(project(repo(["origin", "git@github.com:o/r.git"]), "files")).GH_TOKEN, "github_pat_fake");
  assert.equal(sandboxEnv(project(repo(), "github")).GH_TOKEN, "github_pat_fake");
});

test("the GitHub remote is read from git's config, origin first, in any URL form", () => {
  assert.equal(githubRemoteRepo(repo(["upstream", "https://github.com/up/r.git"], ["origin", "ssh://git@github.com/o/r"])), "o/r");
  assert.equal(githubRemoteRepo(repo(["fork", "https://x@github.com/f/r.git/"])), "f/r");
  assert.equal(githubRemoteRepo(repo(["origin", "https://github.example.com/o/r.git"])), undefined);
  assert.equal(githubRemoteRepo(join(tmpdir(), "no-such-repo-here")), undefined);
});
