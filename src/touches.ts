// The `Touches:` line of a ticket body: the files the ticket expects to change. A new ticket has
// no branch yet, so this line is the only way to see which tickets will meet at landing. It is
// agent-written, so it is a scheduling hint and a warning source, never a guard. This file parses
// the line and says which files git cannot merge line by line; burndown.ts reads both to decide
// which tickets start together (the file hold in schedule.ts).

import { spawnSync } from "node:child_process";
import { stripCode } from "./blockers.ts";
import { covers, type Generated } from "./generated.ts";

/** Lockfiles by name: two branches that both rewrite one conflict whatever the lines say. */
const LOCKFILES = new Set([
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "go.sum",
]);
const isLockfile = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LOCKFILES.has(name) || name.startsWith("bun.lock");
};

/** A blob this big on three lines or fewer is minified: every change touches the same line. */
const MINIFIED_BYTES = 2000;
const MINIFIED_LINES = 3;

const normalise = (p: string) => p.trim().replace(/^(?:\.?\/)+/, "");

/**
 * Every pattern on the body's `Touches:` lines, in order, once each. Code is stripped first, so
 * an example line in a fence or backticks is not read; `[]` when there is no line.
 */
export const parseTouches = (body: string): string[] => {
  const out: string[] = [];
  for (const m of stripCode(body).matchAll(/^[ \t]*touches:[ \t]*(.*)$/gim)) {
    for (const part of m[1].split(",")) {
      const p = normalise(part);
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out;
};

const isGlob = (p: string) => /[*?]/.test(p);

// `**` crosses directories, `*` and `?` stay inside one path segment.
const globToRegExp = (glob: string) => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
};

const git = (root: string, args: string[]) =>
  spawnSync("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });

/**
 * The files at `ref` these patterns name. A plain path matches itself, or everything under it
 * when it is a directory. A plain path that matches nothing is kept as written - a new file can
 * still overlap - but a glob that matches nothing is dropped, as there is no file to name.
 */
export const expandTouches = (root: string, ref: string, patterns: string[]): string[] => {
  const r = git(root, ["ls-tree", "-r", "--name-only", "-z", ref]);
  const tree = r.status === 0 ? r.stdout.toString("utf8").split("\0").filter(Boolean) : [];
  const out: string[] = [];
  const add = (f: string) => {
    if (!out.includes(f)) out.push(f);
  };
  for (const raw of patterns) {
    const pattern = normalise(raw);
    if (!pattern) continue;
    if (isGlob(pattern)) {
      const re = globToRegExp(pattern);
      tree.filter((f) => re.test(f)).forEach(add);
      continue;
    }
    const hits = tree.filter((f) => covers(pattern, f));
    if (hits.length) hits.forEach(add);
    else add(pattern.replace(/\/$/, ""));
  }
  return out;
};

/**
 * True when git cannot merge this file usefully: a lockfile, a file a `generated` entry
 * rewrites, or a minified blob. Size and lines come from the blob at `ref`, never the working
 * tree; a path with no blob there (a new file) is not minified.
 */
export const unmergeable = (root: string, ref: string, path: string, generated: Generated[]): boolean => {
  const file = normalise(path);
  if (isLockfile(file) || generated.some((g) => g.paths.some((p) => covers(p, file)))) return true;
  const size = git(root, ["cat-file", "-s", `${ref}:${file}`]);
  if (size.status !== 0 || Number(size.stdout.toString("utf8").trim()) < MINIFIED_BYTES) return false;
  const blob = git(root, ["cat-file", "blob", `${ref}:${file}`]);
  if (blob.status !== 0) return false;
  const text = blob.stdout.toString("utf8").replace(/\r?\n$/, "");
  return text.split("\n").length <= MINIFIED_LINES;
};
