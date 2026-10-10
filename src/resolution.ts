// Checking a conflict resolution against git's own merge. A resolver that finishes a base merge
// can quietly drop or rewrite lines outside the conflicted hunks ("take ours" across a whole
// file) and keep every gate green; the lines lost may be another ticket's landed work. Git's
// automatic merge says exactly which paths needed a decision, so a change anywhere else that the
// base side had changed is a stray. A path only the branch has (a new file, a file the base never
// touched) can carry none of another ticket's lines and is left to the narrow review. Read-only
// plumbing on the host, as `checkLandingMerge` in land.ts does.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_OUTPUT, ownCommitList, sh, staleBaseParents } from "./sandbox.ts";
import { covers, type Exec, type Generated, shq } from "./generated.ts";

// `merge-tree --write-tree` arrived in git 2.38.
const MIN_GIT: [number, number] = [2, 38];

let said = false;

/**
 * Whether `root` is a partial (promisor) clone: `extensions.partialClone`, or a remote with `promisor` or
 * `partialclonefilter` set. Some of its objects live only on the remote, which a host merge check cannot fetch.
 */
export const isPartialClone = (root: string): boolean => {
  try {
    return !!sh("git", ["config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"], root);
  } catch {
    return false;
  }
};

/**
 * What a partial clone's missing objects cost, in one sentence: the doctor's warning, the run's line and the closing summary share it.
 * The checks never fetch: the remote's address is read from a `.git/config` that sandboxes can write, and a fetch would use the operator's credentials.
 */
export const PARTIAL_CLONE_GAP =
  "the host's merge checks (a conflict before landing, a conflict resolution against git's own merge) read only the objects held here and never fetch, " +
  "so on an object only the remote has they cannot run, and the merge is not checked; a full clone holds them all";

let gap: string | undefined;
/** The note a run records when a host merge check could not run for missing objects (`noteMissingObjects`); undefined while none has. */
export const mergeCheckGap = () => gap;
/** Forgets the note, so each turn of a multi-turn run (one process, one `burndown()` per turn) records and says it for its own checks only. */
export const resetMergeCheckGap = () => {
  gap = undefined;
};

/**
 * Whether `error` is git failing to read an object the partial clone `root` does not hold. Says so once, on screen,
 * and remembers it for the closing summary: the callers go on as if the merge were clean, and without this nothing shows it.
 */
export const noteMissingObjects = (root: string, error: unknown): boolean => {
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  if (!/unable to read|could not read|missing (blob|tree|commit)|bad object|promisor/i.test(stderr) || !isPartialClone(root)) return false;
  if (!gap) {
    gap = `a host merge check could not run, because objects are missing in this partial clone: ${PARTIAL_CLONE_GAP}`;
    console.log(`${gap}.`);
  }
  return true;
};

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
 * `attrs`, a rev: whose committed `.gitattributes` the merge reads (`GIT_ATTR_SOURCE`, git 2.42+). The temp
 * directory has no work tree to read them from, and without them a `merge=union` file conflicts where the
 * project's own merge does not. A committed attribute can only name a driver in the user's or the
 * operator's own config, never one a sandbox wrote. Older git ignores the variable.
 */
export const withObjectsOnly = <T>(root: string, revs: string[], use: (git: (args: string[]) => string, ids: string[]) => T, attrs?: string): T => {
  const ids = revs.map((rev) => sh("git", ["rev-parse", "--verify", `${rev}^{commit}`], root));
  const attrSource = attrs === undefined ? undefined : sh("git", ["rev-parse", "--verify", `${attrs}^{commit}`], root);
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
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate, GIT_NO_REPLACE_OBJECTS: "1", ...(attrSource && { GIT_ATTR_SOURCE: attrSource }) };
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
 * The paths that conflict in git's own automatic merge of `ours` (the base) and `theirs`, run in a throwaway
 * git directory (`withObjectsOnly`), so nothing a sandbox wrote into the shared `.git` runs and
 * nothing is written there. Throws when git fails; the caller decides what an unanswered check
 * means. Needs git 2.38 (`mergeTreeSupported`). `tree` is the id of the merge's result, conflict
 * markers included when `conflicted` is not empty; the object itself goes with the throwaway
 * directory, so the id is only for comparing with a tree in the project.
 */
export const mergeTree = (root: string, ours: string, theirs: string): { conflicted: Set<string>; tree: string } =>
  withObjectsOnly(root, [ours, theirs], (git, [o, t]) => mergeIn(git, o, t), ours);

/**
 * The paths `resolved` changes relative to git's automatic merge of `ours` and `theirs`, other
 * than the ones that conflicted and the project's generated files, and only where `theirs` (the
 * base) could have put lines another ticket landed: a path it changed since the merge base, or one
 * git's merge carried its changes into (a rename of the branch's). A new file, or one only the
 * branch touched, is left out. Empty when the resolution stayed inside the conflicts and its own
 * files. `undefined` when the check cannot run (git older than 2.38, or a git call failed): it says
 * so once and never throws, so the narrow review remains.
 */
export const strayChanges = (root: string, { ours, theirs, resolved, generated = [], gitVersion }: Resolution): string[] | undefined => {
  const unavailable = (why: string) => {
    if (!said) console.log(`conflict resolutions are not checked against git's own merge: ${why}.`);
    said = true;
    return undefined;
  };
  if (!mergeTreeSupported(root, gitVersion)) return unavailable(`it needs git ${MIN_GIT.join(".")} or newer`);
  try {
    // The merged tree exists only in the throwaway directory, so the diffs against it run there too.
    const { changed, conflicted, baseSide } = withObjectsOnly(root, [ours, theirs, resolved], (git, [o, t, r]) => {
      const { tree, conflicted } = mergeIn(git, o, t);
      // No rename detection: with it a path list names only a rename's target, and a stray
      // deletion paired with an added file would hide behind that path.
      const names = (from: string, to: string) => git(["diff", "--no-renames", "--name-only", "-z", from, to]).split("\0").filter(Boolean);
      // Every merge base: a criss-cross history has several, and a path changed since any of them may hold the base's lines.
      const bases = git(["merge-base", "--all", o, t]).split("\n").filter(Boolean);
      return {
        changed: names(tree, r),
        conflicted,
        // What `theirs` changed under its own name, and what the merge changed in `ours`: the second is where a rename
        // of the branch's received the base's edits to the old name, a path `theirs` never changed.
        baseSide: new Set([...bases.flatMap((base) => names(base, t)), ...names(o, tree)]),
      };
    }, theirs);
    const inGenerated = (f: string) => generated.some((g) => g.paths.some((p) => covers(p, f)));
    return changed.filter((f) => baseSide.has(f) && !conflicted.has(f) && !inGenerated(f));
  } catch (error) {
    if (noteMissingObjects(root, error)) return undefined;
    return unavailable(`git failed (${String(error).split("\n")[0].slice(0, 120)})`);
  }
};

/** How a `strayNote` begins: the closing summary tells a held conflict resolution from any other hold by the outcome text `needs a human: <note>` containing it. */
export const STRAY_NOTE_START = "conflict resolution changed";

/** A cleanly merged file the resolver said it had to change, and why (its `<stray path="...">reason</stray>` line). */
export type NamedStray = { path: string; why: string };

/**
 * `stray` (`strayChanges`) split by what the resolver said of it: `named` are the paths it gave a reason for, with the
 * reason, `unnamed` the rest. A tag naming a path that is not stray, or with no reason, counts for nothing: only a
 * reason for a file the check found lets a change to a clean file go on to the review and the gates.
 */
export const splitStrays = (stray: string[], said: NamedStray[]): { named: NamedStray[]; unnamed: string[] } => {
  const why = new Map(said.filter((s) => s.why).map((s) => [s.path.trim().replace(/^\.\//, ""), s.why]));
  return {
    named: stray.flatMap((path) => (why.has(path) ? [{ path, why: why.get(path)! }] : [])),
    unnamed: stray.filter((path) => !why.has(path)),
  };
};

/**
 * What the narrow review of a resolution is shown of the clean files the resolver named (`MERGE_STRAYS`): the files and
 * its reasons, with the ask to hold each change to what the merge needs. Empty when there are none, so the prompt
 * carries no heading over nothing.
 */
export const namedStraysView = (named: NamedStray[]): string =>
  named.length
    ? "# Files the resolver changed that merged cleanly\n\nThe resolver changed these files, which git merged without a conflict and the base had changed, " +
      "and gave the reason for each. Check each change against the merge's combined diff: it must be only what the merge needs " +
      "(a test or a call adapted to the other side's code), and no line another ticket landed in the file may be lost:\n\n" +
      `${named.map((n) => `- \`${n.path}\` - ${n.why}`).join("\n")}\n\n`
    : "";

/**
 * The note on a ticket held for a resolution that changed more than the conflict: the run record and the tracker comment share it.
 * `stray` are the paths the resolver gave no reason for; `named` those it did, which the note lists apart so a person sees every change.
 */
export const strayNote = (stray: string[], named: string[] = []): string =>
  `${STRAY_NOTE_START} ${stray.join(", ")}, which merged cleanly - check no other ticket's lines were lost` +
  (named.length ? ` (it also gave a reason for ${named.join(", ")})` : "");

/** How the note on a branch held for a rewritten base begins: the closing summary tells it from any other hold by the outcome text `needs a human: <note>` containing it. */
export const REWRITTEN_NOTE_START = "base rewritten under the branch";

/** What `rebuildOnBase` did with a carried branch whose base was rewritten under it (`undefined`: it was not). */
export type Rebuilt =
  /** `was`: the branch's tip before; `onto`: the base tip it now sits on; `picked`: its own commits re-applied; `dropped`: those the base already had the work of. */
  | { kind: "rebuilt"; was: string; onto: string; picked: number; dropped: number }
  /** `merged`: the old base tips the branch holds that the base no longer does; `why`: the cause, for the note. The branch is as it was. */
  | { kind: "held"; was: string; merged: string[]; why: string };

const lastLine = (r: { stdout: string; stderr: string }) => (r.stderr + "\n" + r.stdout).trim().split("\n").at(-1)?.slice(0, 160) ?? "";

/**
 * A carried branch that merged a base which has since been rewritten (`staleBaseParents`) is re-created on the base's
 * tip from its own non-merge commits, cherry-picked in order in the sandbox `box` (never on the host: the sandbox's
 * worktree is the branch's, and its own git does the work, as for the base merge). It is picked on a detached head
 * and the branch moved only when every commit applied, so a branch that cannot be rebuilt is as it was: a commit that
 * conflicts with the new base holds it for a person (`held`, the conflicting commit and files named). A commit the
 * base already has the work of is left out (`dropped`). The old tip stays in the branch's reflog; `was` names it.
 */
export const rebuildOnBase = async (box: Exec, o: { root: string; base: string; branch: string; identity: string }): Promise<Rebuilt | undefined> => {
  const { root, base, branch, identity } = o;
  // One tip for the whole rebuild: a landing moving the base meanwhile is merged in by the pipeline's own base merge after.
  const onto = sh("git", ["rev-parse", `refs/heads/${base}`], root);
  const merged = staleBaseParents(onto, branch, root);
  if (!merged.length) return undefined;
  const was = sh("git", ["rev-parse", `refs/heads/${branch}`], root);
  const own = ownCommitList(onto, branch, root);
  // Named by the old base's tips alone: the parents of the landing merges inside it are in its history already.
  const tips = merged.length > 1 ? sh("git", ["merge-base", "--independent", ...merged], root).split("\n").filter(Boolean) : merged;
  const held = (why: string): Rebuilt => ({ kind: "held", was, merged: tips.map((m) => m.slice(0, 7)), why });
  // The kit's own mechanical commits and checkouts: hooks stay off and signing is not asked, as the gates run on the result.
  const git = `git ${identity} -c core.hooksPath=/dev/null -c commit.gpgsign=false`;
  // Back to the branch as it was. No `-f`: uncommitted files the worktree already held are not ours to discard.
  const restore = async () => {
    await box.exec(`${git} cherry-pick --abort`);
    await box.exec(`${git} checkout -q ${shq(branch)}`);
  };

  const detach = await box.exec(`${git} checkout -q --detach ${onto}`);
  if (detach.exitCode !== 0) return held(`could not check out ${base} to rebuild on it (${lastLine(detach)})`);
  let picked = 0;
  let dropped = 0;
  for (const sha of own) {
    const r = await box.exec(`${git} cherry-pick ${sha}`);
    if (r.exitCode === 0) {
      picked++;
      continue;
    }
    const files = (await box.exec("git diff --name-only --diff-filter=U")).stdout.trim().split("\n").filter(Boolean);
    const stopped = (await box.exec("git rev-parse -q --verify CHERRY_PICK_HEAD")).exitCode === 0;
    // A stopped pick with nothing unmerged and nothing changed is a commit that became empty: the base has its work already.
    if (stopped && !files.length && (await box.exec("git diff --quiet HEAD")).exitCode === 0 && (await box.exec(`${git} cherry-pick --skip`)).exitCode === 0) {
      dropped++;
      continue;
    }
    const why = files.length ? `its commit ${sha.slice(0, 7)} conflicts with ${base} in ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}` : `its commit ${sha.slice(0, 7)} did not apply to ${base} (${lastLine(r)})`;
    await restore();
    return held(why);
  }
  const moved = await box.exec(`${git} checkout -q -B ${shq(branch)}`);
  if (moved.exitCode !== 0) {
    await restore();
    return held(`could not move the branch onto the rebuilt commits (${lastLine(moved)})`);
  }
  return { kind: "rebuilt", was, onto, picked, dropped };
};

/** The note on a ticket held because its branch could not be rebuilt on a rewritten base: the run record and the tracker comment share it. */
export const rewrittenNote = (base: string, held: Extract<Rebuilt, { kind: "held" }>): string =>
  `${REWRITTEN_NOTE_START} - it merged ${held.merged.join(", ")}, which ${base} no longer holds, and ${held.why}; the branch is left as it was (${held.was.slice(0, 7)})`;
