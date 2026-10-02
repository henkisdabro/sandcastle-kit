// Host safety. Sandbox agents run unattended with permission prompts off, and
// Sandcastle bind-mounts the repo's whole `.git` into every container, so
// what a sandbox writes can reach the host in three ways. Each is closed here.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
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
// turn of an autonomy run calls this again.
const hostGitConfig = (key: string, value: string) => {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  for (let i = 0; i < n; i++) if (process.env[`GIT_CONFIG_KEY_${i}`] === key && process.env[`GIT_CONFIG_VALUE_${i}`] === value) return;
  process.env[`GIT_CONFIG_KEY_${n}`] = key;
  process.env[`GIT_CONFIG_VALUE_${n}`] = value;
  process.env.GIT_CONFIG_COUNT = String(n + 1);
};

export const disableHostGitHooks = () => hostGitConfig("core.hooksPath", "/dev/null");

// A landing merge on the host runs while sandboxes add and remove worktrees, and `git merge` starts
// `git gc --auto` when the repo has enough loose objects: maintenance that prunes beside them.
export const disableHostGitGc = () => hostGitConfig("gc.auto", "0");

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
// (landing.ts), so anything else that moves the base still stops the run.
export type Fingerprint = { files: Record<string, string>; base: string };

export const gitFingerprint = (project: Project): Fingerprint => {
  const dir = sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], project.root);
  const inside = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).map((f) => join(dir, sub, f)) : []);
  const paths = [join(dir, "config"), ...inside("info"), ...inside("hooks")];
  const files: Record<string, string> = {};
  for (const f of paths) files[f] = createHash("sha256").update(existsSync(f) ? readFileSync(f) : "").digest("hex");
  return { files, base: sh("git", ["rev-parse", `refs/heads/${project.baseBranch}`], project.root) };
};

const changedFiles = (before: Fingerprint["files"], now: Fingerprint["files"]) =>
  [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((f) => before[f] !== now[f]).sort();

// The two are told apart. A changed config can run a command on the host's
// next git call, so nothing reads the repo after it. A moved base branch is
// more often a person's own commit (a ticket-file edit, a quick fix) than a
// sandbox's; the run cannot tell which, so it lands nothing - but it says
// what moved, instead of calling every commit tampering.
export const assertGitUnchanged = (project: Project, before: Fingerprint, when: string) => {
  const now = gitFingerprint(project);
  const base = project.baseBranch;
  const changed = changedFiles(before.files, now.files);
  if (changed.length) {
    throw new OperatorError(
      `STOPPED ${when}: ${changed.map((f) => relative(realpathSync(project.root), f)).join(", ")} changed while sandboxes ran. A sandbox may have tampered with the shared .git. ` +
        `Inspect \`git -C ${project.root} config --local --list\` and .git/info/ before running any other git command there.`,
    );
  }
  if (now.base !== before.base) {
    // Names, subjects and paths are the sandbox's to choose: shown without
    // control characters, so a planted subject cannot rewrite the terminal.
    const clean = (t: string) => t.replace(/[\x00-\x1f\x7f]/g, "");
    const range = `${before.base}..${now.base}`;
    const commits = sh("git", ["log", "--format=%h by %cn, %cr: %s", "-5", range], project.root).split("\n").filter(Boolean).map(clean);
    const files = sh("git", ["diff", "--name-only", range], project.root).split("\n").filter(Boolean).map(clean);
    throw new OperatorError(
      `STOPPED ${when}: ${base} moved while sandboxes ran (${commits.join("; ") || `${before.base.slice(0, 7)} -> ${now.base.slice(0, 7)}, not a fast-forward`}` +
        `${files.length ? `; changes ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}` : ""}). ` +
        `A run cannot tell a person's commit from a sandbox's, so it merged nothing. Check the commits are yours - a sandbox can ` +
        `set any name - with \`git show --stat ${before.base.slice(0, 9)}..${now.base.slice(0, 9)}\`; if they are, \`sandcastle run\` again and each branch starts from where it stopped.`,
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
