// A commit made on the base branch while a run's opening base gates run stops the run at the check before the gate
// sandbox closes, and Sandcastle's close never runs after a failed check: the sandbox's worktree and its
// `sandcastle/base-gates-*` branch stay behind. The stop's message names both and the `sandcastle clean` step, so a
// person is not left to find them. Run for real over a temp repo and a fake `docker` on PATH: no Docker, model or network.
//
//   pnpm test:file test/base-gates-stop-leftovers.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-base-gates-leftovers-")));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
process.env.XDG_CONFIG_HOME = join(TMP, "config");
mkdirSync(join(TMP, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(TMP, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];

// A docker whose gate command `move-base` is a person's commit on the base branch, made while the gates run.
const DOCKER = join(TMP, "docker");
mkdirSync(DOCKER, { recursive: true });
writeFileSync(
  join(DOCKER, "docker"),
  `#!/bin/sh
case "$1" in
  run) while [ $# -gt 0 ]; do [ "$1" = "--name" ] && echo "$2" > "$FAKE_DOCKER/name"; shift; done ;;
  ps) case "$2" in -aq) cat "$FAKE_DOCKER/name" 2>/dev/null ;; esac ;;
  exec)
    case "$*" in
      *"git rev-parse HEAD"*) git -C "$FAKE_DOCKER_REPO" rev-parse main ;;
      *move-base*) git -C "$FAKE_DOCKER_REPO" commit -q --allow-empty -m "a person's commit" ;;
    esac ;;
esac
exit 0
`,
);
chmodSync(join(DOCKER, "docker"), 0o755);
process.env.PATH = [DOCKER, dirname(process.execPath), process.env.PATH].join(delimiter);
process.env.FAKE_DOCKER = DOCKER;

const { requireGreenBase } = await import("../src/gates.ts");
const { assertGitUnchanged, gitFingerprint, GuardStop, guardWords } = await import("../src/guard.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");

// A sandbox Sandcastle never closed is named on stderr by its own exit handler ("Worktree preserved at"), which is the
// stop's case here: said to a person in a run, it is nothing for this file's output.
after(() => {
  console.error = () => {};
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("a commit on the base during the opening base gates stops the run, and the stop names the worktree and branch it leaves and `sandcastle clean`", async () => {
  const root = join(TMP, "repo");
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "start");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "move-base" }] };\n`);
  process.env.FAKE_DOCKER_REPO = root;
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    const plan = writePlan(project).file;
    const atStart = gitFingerprint(project);
    const error = await quietly(() => requireGreenBase(project, "sandcastle-fixture:t", plan, true, "run-1", undefined, (when) => assertGitUnchanged(project, atStart, when))).then(
      () => assert.fail("the run was not stopped"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof GuardStop, String(error));
    assert.match(error.message, /^STOPPED before closing the base-gates sandbox: main moved while sandboxes ran \(.*a person's commit/s);
    // Both leftovers are on disk, and the message names each as it is.
    const branch = git(root, "branch", "--list", "sandcastle/base-gates-*", "--format=%(refname:short)");
    assert.match(branch, /^sandcastle\/base-gates-\d+$/);
    const wt = git(root, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).filter((p) => p !== root);
    assert.equal(wt.length, 1);
    const rel = wt[0].slice(root.length + 1);
    assert.match(rel, /^\.sandcastle\/worktrees\/sandcastle-base-gates-\d+$/);
    assert.ok(error.message.includes(`worktree (${rel})`), error.message);
    assert.ok(error.message.includes(`branch (${branch})`), error.message);
    assert.match(error.message, /hold no work: `sandcastle clean` removes them/);
    // The stop keeps its words for the run's summary.
    assert.equal(guardWords(error).what, "main moved while sandboxes ran");
  } finally {
    process.chdir(cwd);
  }
});
