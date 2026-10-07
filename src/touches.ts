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

/**
 * Whether a path is conventionally a test: under a `test/`, `tests/` or `__tests__/` directory, or
 * named `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py` or `*_test.py`. An agent adds each test in
 * a new file named after the behaviour, a name no ticket can know, so landing does not count an
 * added one as an overrun of the `Touches:` line.
 */
export const isTestPath = (path: string): boolean => {
  const parts = normalise(path).split("/");
  const name = parts.pop() ?? "";
  return (
    parts.some((d) => d === "test" || d === "tests" || d === "__tests__") ||
    /^.+\.(?:test|spec)\..+$/.test(name) ||
    /_test\.go$/.test(name) ||
    /^test_.+\.py$/.test(name) ||
    /_test\.py$/.test(name)
  );
};

/**
 * Whether a path is a project's agent-instructions file: `AGENTS.md` or `CLAUDE.md`, at the root or
 * in any directory. A ticket that adds a module must add its row to the layout table there, so
 * landing does not count a change to one as an overrun when the branch also adds a file.
 */
export const isAgentDoc = (path: string): boolean => /^(?:AGENTS|CLAUDE)\.md$/.test(normalise(path).split("/").pop() ?? "");

/**
 * Docs a repo's rules have every change touch: any Markdown file, and anything under `docs/` or
 * `skill/`. A ticket's `Touches:` line seldom names them, so `overrunPaths` folds them into a count.
 */
export const isDocPath = (path: string): boolean => {
  const p = normalise(path);
  return /\.md$/i.test(p) || p.startsWith("docs/") || p.startsWith("skill/");
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

/** How far from a path the word "new" may stand, on its line, for the ticket to be saying the path is new. */
const NEW_WITHIN = 40;

/** Whether `body`, outside its `Touches:` lines, names `path` with the word "new" beside it on the same line. */
const namedAsNew = (body: string, path: string): boolean => {
  const prose = body.split("\n").filter((l) => !/^[ \t]*touches:/i.test(l));
  for (const line of prose) {
    for (let at = line.indexOf(path); at >= 0; at = line.indexOf(path, at + 1)) {
      // The path itself is left out of the window: `src/new-ui.ts` does not call itself new.
      const near = `${line.slice(Math.max(0, at - NEW_WITHIN), at)} ${line.slice(at + path.length, at + path.length + NEW_WITHIN)}`;
      if (/\bnew\b/i.test(near)) return true;
    }
  }
  return false;
};

/**
 * The `Touches:` entries of `body` that name nothing at `ref`: a plain path with no file or
 * directory there, and a glob matching no file. `expandTouches` keeps the first (a new file can
 * still overlap) and drops the second, so neither shows in a queue's listing; this says them, for
 * `queue --lint` to ask "a new file, or a typo?". A plain path the body names elsewhere beside the
 * word "new" (the ticket says it is a new file) is left out. `[]` when `ref` has no tree to read.
 */
export const missingTouches = (root: string, ref: string, body: string): string[] => {
  const r = git(root, ["ls-tree", "-r", "--name-only", "-z", ref]);
  if (r.status !== 0) return [];
  const tree = r.stdout.toString("utf8").split("\0").filter(Boolean);
  return parseTouches(body).filter((pattern) => {
    if (isGlob(pattern)) {
      const re = globToRegExp(pattern);
      return !tree.some((f) => re.test(f));
    }
    if (tree.some((f) => covers(pattern, f))) return false;
    return !namedAsNew(body, pattern.replace(/\/$/, ""));
  });
};

// Sizes of every blob at a commit, from one `git ls-tree -r -l`. Keyed by the commit, not the ref
// name: the base branch moves as tickets land, and a ref name would keep serving the old tree. A
// few are kept, as a run reads the base's tip and a ticket's head at most.
const sizeCache = new Map<string, Map<string, number>>();
const KEPT_TREES = 4;

const sizesAt = (root: string, ref: string): Map<string, number> | undefined => {
  const sha = /^[0-9a-f]{40}$/.test(ref) ? { status: 0, stdout: Buffer.from(ref) } : git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (sha.status !== 0) return undefined;
  const key = `${root}\0${sha.stdout.toString("utf8").trim()}`;
  const hit = sizeCache.get(key);
  if (hit) return hit;
  const tree = git(root, ["ls-tree", "-r", "-l", "-z", key.slice(root.length + 1)]);
  if (tree.status !== 0) return undefined;
  const sizes = new Map<string, number>();
  // "<mode> <type> <object> <size, padded>\t<path>"; a submodule's size is "-".
  for (const entry of tree.stdout.toString("utf8").split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3]);
    if (Number.isFinite(size)) sizes.set(entry.slice(tab + 1), size);
  }
  sizeCache.set(key, sizes);
  for (const old of [...sizeCache.keys()].slice(0, Math.max(0, sizeCache.size - KEPT_TREES))) sizeCache.delete(old);
  return sizes;
};

/**
 * The paths among `paths` git cannot merge usefully: a lockfile, a file a `generated` entry
 * rewrites, or a minified blob. Size and lines come from the blob at `ref`, never the working
 * tree; a path with no blob there (a new file) is not minified. The sizes come from one tree read
 * (cached per commit), and a blob is read only when it is at least `MINIFIED_BYTES` long: a broad
 * `Touches:` line over a large repo would otherwise be one git call per file.
 */
export const unmergeableFiles = (root: string, ref: string, paths: string[], generated: Generated[]): string[] => {
  let sizes: Map<string, number> | undefined;
  return paths.filter((path) => {
    const file = normalise(path);
    if (isLockfile(file) || generated.some((g) => g.paths.some((p) => covers(p, file)))) return true;
    sizes ??= sizesAt(root, ref) ?? new Map();
    if ((sizes.get(file) ?? 0) < MINIFIED_BYTES) return false;
    const blob = git(root, ["cat-file", "blob", `${ref}:${file}`]);
    if (blob.status !== 0) return false;
    const text = blob.stdout.toString("utf8").replace(/\r?\n$/, "");
    return text.split("\n").length <= MINIFIED_LINES;
  });
};

/** `unmergeableFiles` for one path; prefer the list form, which reads the tree once. */
export const unmergeable = (root: string, ref: string, path: string, generated: Generated[]): boolean =>
  unmergeableFiles(root, ref, [path], generated).length > 0;
