// Host safety. Sandbox agents run unattended with permission prompts off, and
// Sandcastle bind-mounts the repo's whole `.git` into every container, so
// what a sandbox writes can reach the host in three ways. Each is closed here.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export const disableHostGitHooks = () => {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  process.env[`GIT_CONFIG_KEY_${n}`] = "core.hooksPath";
  process.env[`GIT_CONFIG_VALUE_${n}`] = "/dev/null";
  process.env.GIT_CONFIG_COUNT = String(n + 1);
};

// ---------------------------------------------------------------------------
// 2. The shared `.git`. A container can rewrite `.git/config` (a
// `core.fsmonitor` command runs on the host's next `git status`), the files in
// `.git/info/`, or move the base branch. Fingerprinted at start and checked
// after every pipeline and before landing; any change stops the run before
// the host runs another git command in the repo.
// ---------------------------------------------------------------------------

export type Fingerprint = { files: string; base: string };

export const gitFingerprint = (project: Project): Fingerprint => {
  const dir = sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], project.root);
  const files = [join(dir, "config"), ...(existsSync(join(dir, "info")) ? readdirSync(join(dir, "info")).map((f) => join(dir, "info", f)) : [])];
  const h = createHash("sha256");
  for (const f of files.sort()) h.update(f).update(existsSync(f) ? readFileSync(f) : "");
  return { files: h.digest("hex"), base: sh("git", ["rev-parse", `refs/heads/${project.baseBranch}`], project.root) };
};

// The two are told apart. A changed config can run a command on the host's
// next git call, so nothing reads the repo after it. A moved base branch is
// more often a person's own commit (a ticket-file edit, a quick fix) than a
// sandbox's; the run cannot tell which, so it lands nothing - but it says
// what moved, instead of calling every commit tampering.
export const assertGitUnchanged = (project: Project, before: Fingerprint, when: string) => {
  const now = gitFingerprint(project);
  const base = project.baseBranch;
  if (now.files !== before.files) {
    throw new OperatorError(
      `STOPPED ${when}: .git/config or .git/info/ changed while sandboxes ran. A sandbox may have tampered with the shared .git. ` +
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

// ---------------------------------------------------------------------------
// One run per project at a time: two would take the same queue, the same
// branches and merge into the same checkout.
// ---------------------------------------------------------------------------

export const lockRun = (project: Project) => {
  const file = join(project.root, ".sandcastle/logs/run.lock");
  // A project's first run has no logs/ yet - init does not create it.
  mkdirSync(join(project.root, ".sandcastle/logs"), { recursive: true });
  const { mine, owner } = takeLock(file, project.name);
  if (!mine) {
    throw new OperatorError(
      owner
        ? `Another sandcastle run of this project is live (pid ${owner}). One run per project at a time.`
        : "Another sandcastle run of this project is starting. One run per project at a time.",
    );
  }
  process.on("exit", () => releaseLock(file, mine));
};
