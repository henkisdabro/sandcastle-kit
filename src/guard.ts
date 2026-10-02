// Host safety. Sandbox agents run unattended with permission prompts off, and
// Sandcastle bind-mounts the repo's whole `.git` into every container, so
// what a sandbox writes can reach the host in three ways. Each is closed here.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Project } from "./config.ts";
import { releaseLock, takeLock } from "./pool.ts";
import { sh } from "./sandbox.ts";
import { OperatorError } from "./errors.ts";

// ---------------------------------------------------------------------------
// 1. Git hooks on the host. `git merge --no-verify` still runs post-merge, and
// Sandcastle's host-side `git worktree add` runs post-checkout - from the
// BRANCH's own hook files, so a branch that adds `.husky/post-merge` would run
// on the host when it lands. This process and every git it starts (Sandcastle's
// included) runs with hooks off. The container never sees this environment, so
// the repo's hooks still run on agent commits inside the sandbox.
// ---------------------------------------------------------------------------

// One more `GIT_CONFIG_*` pair for this process and every git it starts. Not added twice: each
// turn of an autonomy run calls this again, and the first value stays - a later turn reads a
// config that sandboxes have had their hands on.
const hostGitConfig = (key: string, value: string) => {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  for (let i = 0; i < n; i++) if (process.env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === key.toLowerCase()) return;
  process.env[`GIT_CONFIG_KEY_${n}`] = key;
  process.env[`GIT_CONFIG_VALUE_${n}`] = value;
  process.env.GIT_CONFIG_COUNT = String(n + 1);
};

export const disableHostGitHooks = () => hostGitConfig("core.hooksPath", "/dev/null");

// A landing merge on the host runs while sandboxes add and remove worktrees, and `git merge` starts
// `git gc --auto` when the repo has enough loose objects: maintenance that prunes beside them.
export const disableHostGitGc = () => hostGitConfig("gc.auto", "0");

// Config keys that make the host's git run a program. A sandbox can write `.git/config` at any
// moment, and the `.git` check before each host write leaves a gap of milliseconds before the git
// call; command-scope config (`GIT_CONFIG_*`) wins over every config file, so a value pinned here
// is the one git uses whatever lands in the file. Signing is off: a host merge or commit would run
// `gpg.program`. Drivers and programs the config names at the start keep that value, so a planted
// replacement never runs. A driver named in `.gitattributes` with no config at the start is not
// pinned - an empty value breaks git's built-in drivers (`merge=union`) - and is left to the check.
const COMMAND_KEYS =
  "^(filter\\.[^.]+\\.(clean|smudge|process)|merge\\.[^.]+\\.driver|diff\\.[^.]+\\.(command|textconv)|diff\\.external" +
  "|core\\.(pager|editor|askpass|sshcommand)|gpg\\.(.+\\.)?program|sequence\\.editor)$";

export const pinHostGitConfig = (root: string) => {
  hostGitConfig("core.fsmonitor", "false");
  hostGitConfig("commit.gpgSign", "false");
  hostGitConfig("tag.gpgSign", "false");
  let entries = "";
  try {
    entries = sh("git", ["config", "-z", "--get-regexp", COMMAND_KEYS], root);
  } catch {
    // Exit 1: none of the keys is set.
  }
  for (const entry of entries.split("\0").filter(Boolean)) {
    const at = entry.indexOf("\n");
    if (at > 0) hostGitConfig(entry.slice(0, at), entry.slice(at + 1));
  }
};

// ---------------------------------------------------------------------------
// 2. The shared `.git`. A container can rewrite `.git/config` (a
// `core.fsmonitor` command runs on the host's next `git status`), the files in
// `.git/info/`, plant a hook in `.git/hooks/` (it runs on the operator's next
// checkout or commit, long after the run's own hooks-off environment is gone),
// or move the base branch. Fingerprinted at start and checked
// after every pipeline and before landing; any change stops the run before
// the host runs another git command in the repo.
// ---------------------------------------------------------------------------

// `files` maps each fingerprinted path to its content's hash, so a change can name the file.
// `base` is the base tip the run expects: the landing worker moves it with its own writes
// (landing.ts), so anything else that moves the base still stops the run. "" is a base ref that
// does not exist.
// `branches` is the tip of every `agent/issue-*` branch the run expects, and `flying` the ones whose
// pipeline runs now (the agent is committing): a branch in it may move, and only has to exist. The
// kit moves both with its own writes - `begin`, `settle` and `forget` in landing.ts - so a branch
// it deleted itself (a squash landing) is never "restored". Every pipeline and the landing worker
// check the same two objects, hence the sharing in `gitFingerprint`.
export type Fingerprint = { files: Record<string, string>; base: string; branches: Record<string, string>; flying: Set<string> };

const AGENT_BRANCH = /^agent\/issue-/;

const commonDir = (root: string) => sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], root);

/** A ref's tip, or "" when it does not exist: a deleted ref is something to report, not a raw git error. */
export const tipOf = (root: string, ref: string) => {
  try {
    return sh("git", ["rev-parse", "--verify", "-q", ref], root);
  } catch {
    return "";
  }
};

const agentBranches = (root: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const line of sh("git", ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/agent/"], root).split("\n")) {
    const at = line.indexOf(" ");
    const name = line.slice(at + 1).replace(/^refs\/heads\//, "");
    if (at > 0 && AGENT_BRANCH.test(name)) found[name] = line.slice(0, at);
  }
  return found;
};

/**
 * With `share` (the run's own fingerprint), the branches and the in-flight set are that one's, not a
 * fresh reading: a check that a landing makes while pipelines run must not take an agent's commits,
 * or a pipeline that ended meanwhile, for a branch that moved.
 */
export const gitFingerprint = (project: Project, share?: Pick<Fingerprint, "branches" | "flying">): Fingerprint => {
  const dir = commonDir(project.root);
  const inside = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).map((f) => join(dir, sub, f)) : []);
  // HEAD too: a sandbox that repoints it makes the host's landing merge commit on another branch,
  // while the base - and so the check - stays where it was.
  // Not info/refs: `git repack` rewrites it (an auto gc in a sandbox's commit does), it is only an
  // index for the dumb HTTP transport and runs nothing - fingerprinted, it read as tampering.
  const info = inside("info").filter((f) => f !== join(dir, "info", "refs"));
  const paths = [join(dir, "config"), join(dir, "HEAD"), ...info, ...inside("hooks")];
  const files: Record<string, string> = {};
  for (const f of paths) files[f] = createHash("sha256").update(existsSync(f) ? readFileSync(f) : "").digest("hex");
  return {
    files,
    base: tipOf(project.root, `refs/heads/${project.baseBranch}`),
    branches: share?.branches ?? agentBranches(project.root),
    flying: share?.flying ?? new Set(),
  };
};

const changedFiles = (before: Fingerprint["files"], now: Fingerprint["files"]) =>
  [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((f) => before[f] !== now[f]).sort();

// Names, subjects and paths are the sandbox's to choose: shown without
// control characters, so a planted subject cannot rewrite the terminal.
const clean = (t: string) => t.replace(/[\x00-\x1f\x7f]/g, "");

// ---------------------------------------------------------------------------
// The agent branches' second copy. A container can delete a branch no live worktree holds, and a
// `reflog expire` plus `gc --prune=now` there removes its commits for good, so the recorded tip
// alone cannot bring it back. A pipeline that ends hands its branch to a bare repo under
// `.sandcastle/`, which no sandbox mounts (Sandcastle mounts a sandbox's own worktree, the shared
// `.git` and the user's `mounts`; `test/backup-branches.test.ts` holds that), and a vanished
// branch is fetched back from it. Never bundles: a bundle is a file to keep in step, a ref in a
// repo is one fetch.
// ---------------------------------------------------------------------------

export const backupRepo = (project: Project) => join(project.root, ".sandcastle", "backup.git");

// `--git-dir` explicit: no discovery of the enclosing project (its config is the sandboxes' to
// write), and `safe.bareRepository=explicit` in a user's config does not refuse it.
const backupGit = (project: Project, args: string[]) => sh("git", ["--git-dir", backupRepo(project), ...args], join(project.root, ".sandcastle"));

const backupTip = (project: Project, branch: string) => {
  if (!existsSync(join(backupRepo(project), "HEAD"))) return "";
  try {
    return backupGit(project, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
  } catch {
    return "";
  }
};

/** Copy the branch's tip into the backup repo, creating it. Throws on a git failure: the caller says so and goes on. */
export const backupBranch = (project: Project, branch: string) => {
  const dir = backupRepo(project);
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(join(project.root, ".sandcastle"), { recursive: true });
    sh("git", ["init", "--bare", "-q", dir], join(project.root, ".sandcastle"));
    // The project's `.sandcastle/.gitignore` may predate this directory, and an untracked repo in
    // the checkout would make `git status` dirty: the repo ignores itself.
    writeFileSync(join(dir, ".gitignore"), "*\n");
  }
  backupGit(project, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", project.root, `+refs/heads/${branch}:refs/heads/${branch}`]);
};

/** Drop a branch's entry once its ticket has landed. Never throws: a copy left behind costs nothing. */
export const dropBackup = (project: Project, branch: string) => {
  try {
    if (backupTip(project, branch)) backupGit(project, ["update-ref", "-d", `refs/heads/${branch}`]);
  } catch {
    /* the entry stays; the next run's check does not look at it */
  }
};

const hasCommit = (root: string, sha: string) => {
  try {
    sh("git", ["cat-file", "-e", `${sha}^{commit}`], root);
    return true;
  } catch {
    return false;
  }
};

// Puts a vanished branch back where the run expected it, and says so. The copy in the backup repo
// first when it is that tip (the objects may be gone from the shared `.git`), then the recorded
// commit if it still resolves, then whatever the backup holds; no copy at all stops the run.
const restoreBranch = (project: Project, name: string, want: string, when: string): string => {
  const root = project.root;
  const ref = `refs/heads/${name}`;
  const kept = backupTip(project, name);
  // `--update-head-ok`: a ticket in flight has its worktree on this branch, which fetch refuses to update.
  const fromBackup = () => sh("git", ["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--update-head-ok", backupRepo(project), `+${ref}:${ref}`], root);
  let source: string;
  if (kept && kept === want) {
    fromBackup();
    source = "the backup";
  } else if (hasCommit(root, want)) {
    sh("git", ["update-ref", ref, want, ""], root);
    source = "its recorded tip";
  } else if (kept) {
    fromBackup();
    source = "an older backup";
  } else {
    throw new OperatorError(
      `STOPPED ${when}: ${clean(name)} was deleted while sandboxes ran, and no copy of its commits survives (it was last at ${want.slice(0, 12)}, which the shared .git no longer holds, and ${relative(root, backupRepo(project))} has no entry). ` +
        `A sandbox may have deleted it and removed its commits.`,
    );
  }
  const tip = tipOf(root, ref);
  console.log(`${clean(name)} was deleted from the shared .git while sandboxes ran; restored from ${source} (${tip.slice(0, 12)}). A sandbox may have deleted it - the run goes on.`);
  return tip;
};

// A sandbox's worktree record names the worktree by its host path. `git worktree repair` run in a
// container rewrites it to the container path, and the host then cannot find that sandbox.
// Kit-made worktrees only (`agent-issue-*`, and `sandcastle-*` for a landing's scratch): a person's
// own worktrees live where they like.
const rewrittenWorktrees = (project: Project): string[] => {
  const records = join(commonDir(project.root), "worktrees");
  if (!existsSync(records)) return [];
  const under = [...new Set([project.root, realpathSync(project.root)])].map((r) => join(r, ".sandcastle", "worktrees") + sep);
  return readdirSync(records)
    .filter((name) => /^(agent-issue-|sandcastle-)/.test(name) && existsSync(join(records, name, "gitdir")))
    .filter((name) => {
      const at = readFileSync(join(records, name, "gitdir"), "utf8").trim();
      return !under.some((u) => at.startsWith(u));
    })
    .sort();
};

// The three are told apart. A changed config can run a command on the host's
// next git call, so nothing reads the repo after it. A moved base branch is
// more often a person's own commit (a ticket-file edit, a quick fix) than a
// sandbox's; the run cannot tell which, so it lands nothing - but it says
// what moved, instead of calling every commit tampering. An agent branch that vanished is
// restored (the work is the kit's and the copy is exact); one that moved while its ticket was not
// running is a stop.
export const assertGitUnchanged = (project: Project, before: Fingerprint, when: string) => {
  const now = gitFingerprint(project);
  const base = project.baseBranch;
  const root = project.root;
  const changed = changedFiles(before.files, now.files);
  if (changed.length) {
    throw new OperatorError(
      `STOPPED ${when}: ${changed.map((f) => relative(realpathSync(root), f)).join(", ")} changed while sandboxes ran. A sandbox may have tampered with the shared .git. ` +
        `Inspect \`git -C ${root} config --local --list\` and .git/info/ before running any other git command there.`,
    );
  }
  const rewritten = rewrittenWorktrees(project);
  if (rewritten.length) {
    throw new OperatorError(
      `STOPPED ${when}: the worktree record of ${rewritten.join(", ")} no longer holds its host path under .sandcastle/worktrees/ (\`git worktree repair\` in a sandbox writes its container path). ` +
        `The host cannot find ${rewritten.length === 1 ? "that sandbox" : "those sandboxes"} now. Once nothing runs, \`git -C ${root} worktree repair <path>\` for each worktree under .sandcastle/worktrees/ puts the records right.`,
    );
  }
  if (before.base && !now.base) {
    throw new OperatorError(
      `STOPPED ${when}: ${base} was deleted while sandboxes ran. It may be a person's doing, so the run merged nothing. ` +
        `Put it back with \`git -C ${root} update-ref refs/heads/${base} ${before.base}\` (it fails if ${base} exists by then), then \`sandcastle run\` again.`,
    );
  }
  if (now.base !== before.base) {
    // A moved base can leave its old tip unreachable after a gc: no log, but still the clean message.
    const lines = (args: string[]) => {
      try {
        return sh("git", args, root).split("\n").filter(Boolean).map(clean);
      } catch {
        return [];
      }
    };
    const range = `${before.base}..${now.base}`;
    const commits = lines(["log", "--format=%h by %cn, %cr: %s", "-5", range]);
    const files = lines(["diff", "--name-only", range]);
    throw new OperatorError(
      `STOPPED ${when}: ${base} moved while sandboxes ran (${commits.join("; ") || `${before.base.slice(0, 7)} -> ${now.base.slice(0, 7)}, not a fast-forward`}` +
        `${files.length ? `; changes ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}` : ""}). ` +
        `A run cannot tell a person's commit from a sandbox's, so it merged nothing. Check the commits are yours - a sandbox can ` +
        `set any name - with \`git show --stat ${before.base.slice(0, 9)}..${now.base.slice(0, 9)}\`; if they are, \`sandcastle run\` again and each branch starts from where it stopped. ` +
        `If they are not, \`git -C ${root} update-ref refs/heads/${base} ${before.base} ${now.base}\` puts ${base} back (it fails if ${base} moved again).`,
    );
  }
  const moved: string[] = [];
  for (const [name, tip] of Object.entries(before.branches)) {
    const at = now.branches[name];
    if (at === undefined) before.branches[name] = restoreBranch(project, name, tip, when);
    else if (at !== tip && !before.flying.has(name)) moved.push(`${clean(name)} ${tip.slice(0, 12)} -> ${at.slice(0, 12)}`);
  }
  if (moved.length) {
    throw new OperatorError(
      `STOPPED ${when}: ${moved.join(", ")} moved while its ticket was not running. A sandbox may have rewritten another ticket's branch; nothing else touches a branch between its pipeline and its landing. ` +
        `The commit it had is still in the object store unless a gc ran: \`git -C ${root} update-ref refs/heads/<branch> <old tip>\` puts a branch back, and ${relative(root, backupRepo(project))} holds a copy of each branch a pipeline ended with.`,
    );
  }
};

// ---------------------------------------------------------------------------
// 3. What lands. A green branch that changes how the repo executes - hooks,
// CI, agent settings, install scripts - is never merged automatically: the
// gates ran the branch's own scripts, so they cannot vouch for it. It is left
// standing for a human merge.
// ---------------------------------------------------------------------------

const DEFAULT_PROTECTED = [
  ".husky/", ".githooks/", ".github/", ".gitmodules", ".gitattributes",
  ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/",
  ".mcp.json", ".codex/", ".agents/", ".sandcastle/",
  ".npmrc", "pnpm-workspace.yaml", ".yarnrc.yml",
  ".lintstagedrc", "lint-staged.config.", ".pre-commit-config.yaml", "lefthook.yml",
];
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack", "postpack"];

export const protectedChanges = (project: Project, branch: string) => {
  const base = project.baseBranch;
  const changed = sh("git", ["diff", "--name-only", `${base}...${branch}`], project.root).split("\n").filter(Boolean);
  const prefixes = [...DEFAULT_PROTECTED, ...(project.protectedPaths ?? [])];
  const hits = changed.filter((f) => prefixes.some((p) => f === p || f.startsWith(p)));
  // package.json only when an install-time script changed.
  for (const f of changed.filter((f) => f === "package.json" || f.endsWith("/package.json"))) {
    const scripts = (ref: string) => {
      try {
        return JSON.parse(sh("git", ["show", `${ref}:${f}`], project.root)).scripts ?? {};
      } catch {
        return {};
      }
    };
    const [a, b] = [scripts(base), scripts(branch)];
    const moved = INSTALL_SCRIPTS.filter((s) => a[s] !== b[s]);
    if (moved.length) hits.push(`${f} (scripts: ${moved.join(", ")})`);
  }
  return hits;
};

// GitHub warns on a file over 50 MB and refuses a push with one over 100 MB, and a blob that size
// stays in the history for good. A branch that adds or grows one is held like a protected path.
const LARGE_BYTES = 50 * 1024 * 1024;
export const largeFiles = (project: Project, branch: string): string[] =>
  sh("git", ["diff", "--name-only", "--diff-filter=AM", `${project.baseBranch}...${branch}`], project.root)
    .split("\n")
    .filter(Boolean)
    .flatMap((f) => {
      const bytes = Number(sh("git", ["cat-file", "-s", `${branch}:${f}`], project.root));
      return bytes > LARGE_BYTES ? [`${f} (${Math.round(bytes / 1024 / 1024)} MB)`] : [];
    });

/** Why a large file needs a person, and what else to do with it. */
export const largeFilesNote = (files: string[]) =>
  `adds ${files.join(", ")}, over GitHub's 50 MB file warning (it refuses a push with a file over 100 MB), and a file that size stays in the history for good. Merge it by hand if it belongs in git; otherwise keep it out (Git LFS, or a step that downloads it)`;

// ---------------------------------------------------------------------------
// One run per project at a time: two would take the same queue, the same
// branches and merge into the same checkout.
// ---------------------------------------------------------------------------

// Held by this process: a second turn of one `sandcastle run` would otherwise find its own
// live pid in the lock and refuse.
const heldLocks = new Set<string>();

export const lockRun = (project: Project) => {
  const file = join(project.root, ".sandcastle/logs/run.lock");
  if (heldLocks.has(file)) return;
  // A project's first run has no logs/ yet - init does not create it.
  mkdirSync(join(project.root, ".sandcastle/logs"), { recursive: true });
  const { mine, owner } = takeLock(file, project.name);
  if (!mine) {
    throw new OperatorError(
      owner
        ? `Another sandcastle run of this project is live (pid ${owner}). One run per project at a time: wait for it to end (\`sandcastle status\` shows it), or stop it with Ctrl-C in its terminal, then try again.`
        : "Another sandcastle run of this project is starting. One run per project at a time: try again once it has started (`sandcastle status` shows it).",
    );
  }
  heldLocks.add(file);
  process.on("exit", () => releaseLock(file, mine));
};
