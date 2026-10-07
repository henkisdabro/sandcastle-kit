// Checking a conflict resolution against git's own merge. A resolver that finishes a base merge
// can quietly drop or rewrite lines outside the conflicted hunks ("take ours" across a whole
// file) and keep every gate green; the lines lost may be another ticket's landed work. Git's
// automatic merge says exactly which paths needed a decision, so a change anywhere else is a
// stray. Read-only plumbing on the host, as `checkLandingMerge` in land.ts does.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_OUTPUT, sh } from "./sandbox.ts";
import { covers, type Generated } from "./generated.ts";

// `merge-tree --write-tree` arrived in git 2.38.
const MIN_GIT: [number, number] = [2, 38];

let said = false;

/** The refs involved: `ours` and `theirs` are what the merge joined, `resolved` is the resolver's result. */
export type Resolution = {
  ours: string;
  theirs: string;
  resolved: string;
  /** Paths the project regenerates after a merge; git's merge and the resolution may differ there. */
  generated?: Generated[];
  /** `git --version`'s output, injected by a test to simulate an older git. */
  gitVersion?: string;
};

/** Whether this git has `merge-tree --write-tree` (2.38+). `gitVersion` is `git --version`'s output, injected by a test. */
export const mergeTreeSupported = (root: string, gitVersion?: string) => {
  let out = gitVersion;
  try {
    out ??= sh("git", ["--version"], root);
  } catch {
    out = undefined;
  }
  const m = out?.match(/(\d+)\.(\d+)/);
  return !!m && (Number(m[1]) > MIN_GIT[0] || (Number(m[1]) === MIN_GIT[0] && Number(m[2]) >= MIN_GIT[1]));
};

// Every variable that would point git at another repository's parts: the throwaway directory is the whole repository.
const REPO_VARS = ["GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"];

/**
 * Runs `use` with a git that reads `root`'s objects and nothing else of its `.git`: a temp git
 * directory with no config, no `info/` and no refs, borrowing the shared object store as an
 * alternate. A sandbox can write the shared `.git` while its ticket runs, and a merge driver it
 * puts in `.git/config`, mapped by `.git/info/attributes`, would run on the host at the next
 * merge-tree, before any fingerprint check sees it; here there is no driver to run. `revs` are
 * resolved in `root` first (the temp directory has no refs) and handed to `use` as commit ids.
 * Objects git writes stay in the temp directory, removed when `use` returns or throws.
 */
export const withObjectsOnly = <T>(root: string, revs: string[], use: (git: (args: string[]) => string, ids: string[]) => T): T => {
  const ids = revs.map((rev) => sh("git", ["rev-parse", "--verify", `${rev}^{commit}`], root));
  const objects = resolve(root, sh("git", ["rev-parse", "--git-path", "objects"], root));
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-merge-"));
  try {
    mkdirSync(join(dir, "objects"));
    mkdirSync(join(dir, "refs"));
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    // A SHA-256 repository's objects are unreadable to a SHA-1 one: the format is the one setting written, and the kit writes it.
    if (ids.some((id) => id.length === 64)) writeFileSync(join(dir, "config"), "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n");
    // Quoted: the variable is a colon-separated list, so a project path with a `:` would name two missing stores.
    const alternate = `"${objects.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate, GIT_NO_REPLACE_OBJECTS: "1" };
    for (const name of REPO_VARS) delete env[name];
    const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_OUTPUT }).trim();
    return use(git, ids);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// Git's own merge in `git`'s repository; exit 1 means conflicts, which is the case callers ask about: the output is still on stdout.
const mergeIn = (git: (args: string[]) => string, ours: string, theirs: string): { tree: string; conflicted: Set<string> } => {
  let out: string;
  try {
    out = git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs]);
  } catch (error) {
    const stdout = (error as { status?: number; stdout?: string }).status === 1 ? (error as { stdout?: string }).stdout : undefined;
    if (stdout === undefined) throw error;
    out = stdout;
  }
  // `<tree>\0<conflicted path>\0...`; with -z the tree id is NUL-terminated and the runner trims only the ends.
  const [tree, ...rest] = out.split("\0");
  // Git exits 1 for some failures too (a commit it cannot read): with no tree id, that is no answer, not a clean merge.
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) throw new Error(`git merge-tree gave no tree: ${out.slice(0, 200)}`);
  return { tree, conflicted: new Set(rest.filter(Boolean)) };
};

/**
 * The paths that conflict in git's own automatic merge of `ours` and `theirs`, run in a throwaway
 * git directory (`withObjectsOnly`), so nothing a sandbox wrote into the shared `.git` runs and
 * nothing is written there. Throws when git fails; the caller decides what an unanswered check
 * means. Needs git 2.38 (`mergeTreeSupported`).
 */
export const mergeTree = (root: string, ours: string, theirs: string): { conflicted: Set<string> } =>
  withObjectsOnly(root, [ours, theirs], (git, [o, t]) => ({ conflicted: mergeIn(git, o, t).conflicted }));

/**
 * The paths `resolved` changes relative to git's automatic merge of `ours` and `theirs`, other
 * than the ones that conflicted and the project's generated files. Empty when the resolution
 * stayed inside the conflicts. `undefined` when the check cannot run (git older than 2.38, or
 * a git call failed): it says so once and never throws, so the narrow review remains.
 */
export const strayChanges = (root: string, { ours, theirs, resolved, generated = [], gitVersion }: Resolution): string[] | undefined => {
  const unavailable = (why: string) => {
    if (!said) console.log(`conflict resolutions are not checked against git's own merge: ${why}.`);
    said = true;
    return undefined;
  };
  if (!mergeTreeSupported(root, gitVersion)) return unavailable(`it needs git ${MIN_GIT.join(".")} or newer`);
  try {
    // The merged tree exists only in the throwaway directory, so the diff against it runs there too.
    const { changed, conflicted } = withObjectsOnly(root, [ours, theirs, resolved], (git, [o, t, r]) => {
      const { tree, conflicted } = mergeIn(git, o, t);
      // No rename detection: with it a path list names only a rename's target, and a stray
      // deletion paired with an added file would hide behind that path.
      return { changed: git(["diff", "--no-renames", "--name-only", "-z", tree, r]).split("\0").filter(Boolean), conflicted };
    });
    const inGenerated = (f: string) => generated.some((g) => g.paths.some((p) => covers(p, f)));
    return changed.filter((f) => !conflicted.has(f) && !inGenerated(f));
  } catch (error) {
    return unavailable(`git failed (${String(error).split("\n")[0].slice(0, 120)})`);
  }
};

/** The note on a ticket held for a resolution that changed more than the conflict: the run record and the tracker comment share it. */
export const strayNote = (stray: string[]): string =>
  `conflict resolution changed ${stray.join(", ")}, which merged cleanly - check no other ticket's lines were lost`;
