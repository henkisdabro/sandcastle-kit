// Checking a conflict resolution against git's own merge. A resolver that finishes a base merge
// can quietly drop or rewrite lines outside the conflicted hunks ("take ours" across a whole
// file) and keep every gate green; the lines lost may be another ticket's landed work. Git's
// automatic merge says exactly which paths needed a decision, so a change anywhere else is a
// stray. Read-only plumbing on the host, as `checkLandingMerge` in land.ts does.

import { sh } from "./sandbox.ts";
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

/**
 * Git's own automatic merge of `ours` and `theirs`, written to the object store and nowhere else:
 * the merged tree (its conflicted files as git left them) and the paths that conflicted. Throws
 * when git fails; the caller decides what an unanswered check means. Needs git 2.38
 * (`mergeTreeSupported`).
 */
export const mergeTree = (root: string, ours: string, theirs: string): { tree: string; conflicted: Set<string> } => {
  // Exit 1 means conflicts, which is the case callers ask about: the output is still on stdout.
  let out: string;
  try {
    out = sh("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs], root);
  } catch (error) {
    const stdout = (error as { status?: number; stdout?: string }).status === 1 ? (error as { stdout?: string }).stdout : undefined;
    if (stdout === undefined) throw error;
    out = stdout;
  }
  // `<tree>\0<conflicted path>\0...`; with -z the tree id is NUL-terminated and `sh` trims only the ends.
  const [tree, ...rest] = out.split("\0");
  return { tree, conflicted: new Set(rest.filter(Boolean)) };
};

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
    const { tree, conflicted } = mergeTree(root, ours, theirs);
    // No rename detection: with it a path list names only a rename's target, and a stray
    // deletion paired with an added file would hide behind that path.
    const changed = sh("git", ["diff", "--no-renames", "--name-only", "-z", tree, resolved], root).split("\0").filter(Boolean);
    const inGenerated = (f: string) => generated.some((g) => g.paths.some((p) => covers(p, f)));
    return changed.filter((f) => !conflicted.has(f) && !inGenerated(f));
  } catch (error) {
    return unavailable(`git failed (${String(error).split("\n")[0].slice(0, 120)})`);
  }
};

/** The note on a ticket held for a resolution that changed more than the conflict: the run record and the tracker comment share it. */
export const strayNote = (stray: string[]): string =>
  `conflict resolution changed ${stray.join(", ")}, which merged cleanly - check no other ticket's lines were lost`;
