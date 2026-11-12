// The project's tracked `core.hooksPath`, in one place for the three that must agree on it: the sandboxes' pin
// (`sandboxEnv`, src/sandbox.ts), the guard's acceptance of the exact absolute rewrite and the hooks directory it keeps
// protected (src/guard.ts), and what doctor and `lean` say of an absolute value (src/lean.ts). Reads git and the file
// system only, and imports nothing from the kit, so `sandbox.ts` and `guard.ts` can both use it. It writes nothing:
// the kit never writes `.git/config`.

import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

/** Why a relative hooks path turns absolute by itself: shared by doctor, `lean`, the base check and the guard's lines. */
export const REWRITE_NOTE =
  "This matches a known Claude Code rewrite: its worktree setup writes the absolute form of a relative `core.hooksPath` into the shared `.git/config`.";

// Not `sh` from src/sandbox.ts, which imports this file: a plain read, no output, an error as `undefined`.
const git = (root: string, args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

/**
 * A `core.hooksPath` value that names a directory inside the repository, in a tracked directory: relative, no `..`, not
 * in `.git`, an existing directory whose real path is inside the project's, and the directory or one above it
 * (husky's `.husky/_` is ignored by its own `.gitignore`, in the tracked `.husky/`) holds tracked files. `git ls-files`
 * runs with `core.fsmonitor` off: this runs before the pins, over a config nobody has vetted yet.
 */
export const trackedHooksPath = (root: string, value: string): boolean => {
  // oxlint-disable-next-line no-control-regex -- a control character in a path is never a person's own tooling
  if (!value || value.length > 200 || /[\x00-\x1f\x7f\\]/.test(value) || /^[/~-]/.test(value)) return false;
  const parts = value.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || p.toLowerCase() === ".git") || value.split("/").some((p) => p === ".git")) return false;
  try {
    const inside = relative(realpathSync(root), realpathSync(join(root, ...parts)));
    if (!inside || inside.startsWith("..") || !lstatSync(join(root, ...parts)).isDirectory()) return false;
    for (let i = 1; i <= parts.length; i++) {
      if (git(root, ["-c", "core.fsmonitor=false", "ls-files", "-z", "--", `:(literal)${parts.slice(0, i).join("/")}/`])) return true;
    }
  } catch {
    // A path that is not there: not a tracked directory.
  }
  return false;
};

/**
 * The relative hooks path an absolute `core.hooksPath` is the host form of: `<root>/<rel>` naming a directory inside the
 * project, outside `.git`. Undefined for any other value, so the lines never name a fix the value does not imply.
 */
export const ownAbsoluteHooksPath = (root: string, value: string): string | undefined => {
  if (!value.startsWith("/")) return undefined;
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* the root as given */
  }
  for (const base of new Set([root, real])) {
    const rel = relative(base, value);
    if (!rel || rel.startsWith("..") || rel.startsWith("/") || rel.split("/").some((p) => p.toLowerCase() === ".git")) continue;
    try {
      if (lstatSync(join(base, rel)).isDirectory()) return rel;
    } catch {
      /* not there: not this project's own directory */
    }
  }
  return undefined;
};

/** `old` when `next` is exactly its absolute form in this project and `old` is a tracked hooks directory; else undefined. */
export const rewrittenHooksPath = (root: string, old: string | null, next: string | null): string | undefined => {
  if (old === null || next === null || ownAbsoluteHooksPath(root, next) === undefined) return undefined;
  const parts = old.split("/").filter((p) => p && p !== ".").join("/");
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* the root as given */
  }
  if (next !== join(root, parts) && next !== join(real, parts)) return undefined;
  return trackedHooksPath(root, old) ? old : undefined;
};

/**
 * The hooks path R a sandbox is pinned to, from a `core.hooksPath` value: the value itself when it is a tracked
 * hooks directory, or the relative path `ownAbsoluteHooksPath` names for it when that is one; undefined for no value or
 * any other (an absolute path outside the project, a path that climbs out, an untracked directory).
 */
export const pinnedFor = (root: string, value: string | undefined): string | undefined => {
  if (!value) return undefined;
  if (trackedHooksPath(root, value)) return value;
  const own = ownAbsoluteHooksPath(root, value);
  return own !== undefined && trackedHooksPath(root, own) ? own : undefined;
};

/**
 * R for the project now: `pinnedFor` its local `core.hooksPath` (`--local`: the shared `.git/config` is what a sandbox
 * would read, and the host's own hooks are switched off through the environment, which a plain read would answer with).
 */
export const pinnedHooksPath = (root: string): string | undefined => pinnedFor(root, git(root, ["config", "--local", "--get", "core.hooksPath"]) || undefined);
