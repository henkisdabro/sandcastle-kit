// Host safety. Sandbox agents run unattended with permission prompts off, and
// Sandcastle bind-mounts the repo's whole `.git` into every container, so
// what a sandbox writes can reach the host in three ways. Each is closed here.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { sh } from "./sandbox.ts";

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

export const gitFingerprint = (project: Project) => {
  const dir = sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], project.root);
  const files = [join(dir, "config"), ...(existsSync(join(dir, "info")) ? readdirSync(join(dir, "info")).map((f) => join(dir, "info", f)) : [])];
  const h = createHash("sha256");
  for (const f of files.sort()) h.update(f).update(existsSync(f) ? readFileSync(f) : "");
  h.update(sh("git", ["rev-parse", `refs/heads/${project.baseBranch}`], project.root));
  return h.digest("hex");
};

export const assertGitUnchanged = (project: Project, before: string, when: string) => {
  if (gitFingerprint(project) !== before) {
    throw new Error(
      `STOPPED ${when}: .git/config, .git/info/ or ${project.baseBranch} changed while sandboxes ran. ` +
        `A sandbox may have tampered with the shared .git. Inspect \`git -C ${project.root} config --local --list\`, ` +
        `.git/info/ and \`git reflog ${project.baseBranch}\` before running any other git command there.`,
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
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code === "EPERM";
    }
    if (alive) throw new Error(`Another sandcastle run of this project is live (pid ${pid}). One run per project at a time.`);
    unlinkSync(file); // stale - that run was killed
  }
  writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
  process.on("exit", () => {
    try {
      unlinkSync(file);
    } catch {
      /* gone */
    }
  });
};
