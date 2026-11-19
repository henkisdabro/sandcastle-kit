// One normaliser and one matcher for the paths a sandbox branch carries to the host. A guard that compares git's raw
// path bytes misses how the host resolves them: macOS and Windows find `.Husky/pre-commit` where a rule says
// `.husky/`, macOS skips the code points HFS+ ignores, Windows drops trailing dots and spaces, and a directory rule
// never matches a file or symlink committed under the directory's own name. Pure: no git, and only
// `containedHostPath` touches the file system.

import { lstatSync } from "node:fs";
import { join } from "node:path";

/** A path that cannot be normalised. A guard holds it: what it would resolve to on the host is not known. */
export type Unnormalisable = { kind: "unknown"; detail: string };

// The code points git's `is_hfs_dotgit` skips, because HFS+ drops them from a name: `.git‌` opens `.git`.
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/gu;
// oxlint-disable-next-line no-control-regex -- the control characters are the point: a name with one is refused
const CONTROL = /[\u0000-\u001f\u007f]/u;

const fold = (s: string) => s.replace(HFS_IGNORABLE, "").normalize("NFC").toLowerCase().normalize("NFC");

/**
 * The form a case-insensitive host resolves `path` to: NFC, HFS+-ignorable code points removed, each component's
 * trailing dots and spaces stripped (NTFS), lowercased, `.` and empty components dropped, no trailing slash.
 * A `..` component, a control character, an absolute path or a component that strips to nothing cannot be
 * normalised safely, so it gives `unknown` rather than a string.
 */
export const hostKey = (path: string): string | Unnormalisable => {
  if (CONTROL.test(path)) return { kind: "unknown", detail: `${JSON.stringify(path)} has a control character` };
  if (path.startsWith("/")) return { kind: "unknown", detail: `${path} is absolute` };
  const parts: string[] = [];
  for (const raw of fold(path).split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") return { kind: "unknown", detail: `${path} climbs out with ..` };
    const part = raw.replace(/[. ]+$/u, "");
    if (part === "") return { kind: "unknown", detail: `${path} has a component of only dots or spaces` };
    parts.push(part);
  }
  if (!parts.length) return { kind: "unknown", detail: `${JSON.stringify(path)} names no file` };
  return parts.join("/");
};

/**
 * One protected-path rule. `dir` matches the entry itself (a file or symlink of that name) and everything under it;
 * `file` the one path; `prefix` any path that starts with the value (`lint-staged.config.` covers every extension);
 * `basename` a path with a component of that name at any depth, and so everything under such a component.
 * `runner` says what executes the path on the host.
 */
export type PathRule = { kind: "dir" | "file" | "prefix" | "basename"; value: string; runner: string };

// A rule's value folded as a path is, but its trailing dot kept: `lefthook.` is a prefix, and stripping its dot as a
// path's would widen it to `lefthookery`.
const ruleKey = (rule: PathRule) => fold(rule.value).split("/").filter((p) => p && p !== ".").join("/");

const matches = (key: string, rule: PathRule): boolean => {
  const v = ruleKey(rule);
  if (!v) return false;
  switch (rule.kind) {
    case "dir":
      return key === v || key.startsWith(`${v}/`);
    case "file":
      return key === v;
    case "prefix":
      return key.startsWith(v);
    case "basename":
      return key.split("/").includes(v);
  }
};

/**
 * The paths among `paths` that a rule matches on their host form, returned as given - not folded - so a hold
 * message and `git show` name the real file. A path that cannot be normalised is returned too: unknown is held.
 */
export const matchRules = (paths: string[], rules: PathRule[]): string[] =>
  paths.filter((p) => {
    const key = hostKey(p);
    return typeof key !== "string" || rules.some((r) => matches(key, r));
  });

/**
 * Whether `rel` can be written or removed under `root` without leaving it: every directory on the way is `lstat`ed,
 * and a symlink among them is refused (a branch can commit `.claude` as a link to the operator's own). Only `ENOENT`
 * means "nothing there, nothing to cross"; any other error (`EACCES`, `ENOTDIR`) is `unknown`, because what lies
 * past it cannot be read. The final component is the caller's: removing a symlink never follows it.
 */
export const containedHostPath = (root: string, rel: string): { kind: "allow" } | { kind: "refuse" | "unknown"; detail: string } => {
  const key = hostKey(rel);
  if (typeof key !== "string") return key;
  const parts = rel.split("/").filter((p) => p && p !== ".");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    try {
      if (lstatSync(join(root, prefix)).isSymbolicLink()) return { kind: "refuse", detail: `${prefix} is a symlink in this worktree` };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "allow" };
      return { kind: "unknown", detail: `${prefix} cannot be read (${(e as NodeJS.ErrnoException).code ?? String(e)})` };
    }
  }
  return { kind: "allow" };
};
