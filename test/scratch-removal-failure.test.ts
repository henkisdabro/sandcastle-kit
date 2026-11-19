// Removing the scratch worktrees (`removeScratchWorktrees`, src/sandbox.ts) ran git for each with no catch, so the first
// `git worktree remove` or `git branch -D` that failed (a stale `index.lock`, a busy directory) ended the loop: the
// worktrees still to come were never tried, a run's exit (`removeOwnScratchOnExit`, src/guard.ts) swallowed the error
// and printed nothing, and `sandcastle clean` stopped part-way. Now each failure is left with git's reason and the
// loop goes on, and the exit names what it left, with `sandcastle clean` - also when its `.git` check throws.
// A temp repo with a fake `git` ahead on PATH that fails one removal, and a fake `docker` that lists no container.
//
//   pnpm test:file test/scratch-removal-failure.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { loadProject } from "../src/config.ts";
import { removeOwnScratchOnExit } from "../src/guard.ts";
import { cleanProject, recordScratchWorktree, removeScratchWorktrees } from "../src/sandbox.ts";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-scratch-fail-")));
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const git = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A git that fails `worktree remove` of any path ending in `sandcastle-a`, as a stale lock would, and passes the rest on.
const BIN = join(TMP, "bin");
mkdirSync(BIN, { recursive: true });
writeFileSync(
  join(BIN, "git"),
  `#!/bin/sh
case "$*" in
  "worktree remove --force "*/sandcastle-a) echo "fatal: cannot remove: index.lock exists" >&2; exit 128 ;;
esac
exec ${JSON.stringify(REAL_GIT)} "$@"
`,
);
writeFileSync(join(BIN, "docker"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BIN, "git"), 0o755);
chmodSync(join(BIN, "docker"), 0o755);
process.env.PATH = [BIN, process.env.PATH].join(delimiter);
mkdirSync(join(TMP, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(TMP, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
process.env.XDG_CONFIG_HOME = join(TMP, "config");
process.env.XDG_CACHE_HOME = join(TMP, "cache");

let n = 0;
/** A temp repo with two scratch worktrees, `sandcastle-a` (whose removal fails) and `sandcastle-b`, each on its `sandcastle/*` branch. */
const repo = () => {
  const root = join(TMP, `repo-${++n}`);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, "tracked.txt"), "tracked\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "start");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "true" }] };\n`);
  for (const name of ["a", "b"]) git(root, "worktree", "add", "-q", "-b", `sandcastle/${name}`, join(root, `.sandcastle/worktrees/sandcastle-${name}`));
  return root;
};
const scratchBranches = (root: string) => git(root, "branch", "--format=%(refname:short)", "--list", "sandcastle/*").split("\n").filter(Boolean);

/** What `fn` wrote through console.error, while it ran. */
const stderrOf = (fn: () => void): string => {
  const said: string[] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => void said.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = write;
  }
  return said.join("\n");
};

test("one scratch worktree that git fails to remove is left with git's reason, and the next is still removed with its branch", async () => {
  const root = repo();
  const project = await loadProject(root);
  const result = removeScratchWorktrees(project);
  const a = join(root, ".sandcastle/worktrees/sandcastle-a");
  const b = join(root, ".sandcastle/worktrees/sandcastle-b");
  assert.deepEqual(result.removed, [b]);
  assert.deepEqual(result.branches, ["sandcastle/b"]);
  assert.equal(result.left.length, 1);
  assert.equal(result.left[0].path, a);
  assert.equal(result.left[0].branch, "sandcastle/a");
  assert.match(result.left[0].reason, /index\.lock exists/);
  assert.ok(!existsSync(b));
  assert.deepEqual(scratchBranches(root), ["sandcastle/a"]);
});

test("`sandcastle clean` goes on past a scratch worktree git fails to remove, and reports it as left with its branch kept", async () => {
  const root = repo();
  const project = await loadProject(root);
  const a = join(root, ".sandcastle/worktrees/sandcastle-a");
  const b = join(root, ".sandcastle/worktrees/sandcastle-b");
  const result = cleanProject(project, false);
  assert.deepEqual(result.worktrees, [b]);
  assert.deepEqual(result.left.map((l) => [l.path, l.branch]), [[a, "sandcastle/a"]]);
  assert.match(result.left[0].reason, /index\.lock exists/);
  assert.deepEqual(scratchBranches(root), ["sandcastle/a"]);
});

test("a run's exit removes what it can, never throws, and prints a stderr line naming the worktree it left and `sandcastle clean`", async () => {
  const root = repo();
  const project = await loadProject(root);
  const a = join(root, ".sandcastle/worktrees/sandcastle-a");
  const b = join(root, ".sandcastle/worktrees/sandcastle-b");
  recordScratchWorktree(a);
  recordScratchWorktree(b);
  let removed: string[] = [];
  const out = stderrOf(() => (removed = removeOwnScratchOnExit(project, () => undefined, false)));
  assert.deepEqual(removed, [b]);
  assert.ok(!existsSync(b));
  assert.ok(out.includes(a), out);
  assert.match(out, /`sandcastle clean`/);
});

test("a run's exit whose .git check throws removes nothing, never throws, and prints a stderr line naming the worktrees and `sandcastle clean`", async () => {
  const root = repo();
  const project = await loadProject(root);
  const a = join(root, ".sandcastle/worktrees/sandcastle-a");
  const b = join(root, ".sandcastle/worktrees/sandcastle-b");
  recordScratchWorktree(a);
  recordScratchWorktree(b);
  let removed: string[] = ["unset"];
  const out = stderrOf(() => (removed = removeOwnScratchOnExit(project, () => { throw new Error(".git changed"); }, false)));
  assert.deepEqual(removed, []);
  assert.ok(existsSync(a) && existsSync(b));
  assert.ok(out.includes(a) && out.includes(b), out);
  assert.match(out, /`sandcastle clean`/);
});
