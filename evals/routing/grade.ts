// Grading a tree: the reference's tests (and any probe's) copied over it, each run on its own with a
// time limit, the way the repository runs one file. Pass/fail per file; no model involved.
//
// A tree is graded twice per trial - at the implementer's last commit and at what the run left - so
// one run says both what the implementer alone delivered and what the review and repair added.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, type Task } from "./tasks.ts";
import { WORK } from "./trial.ts";

export type FileResult = { file: string; pass: boolean; code: number | null; seconds: number; tail?: string };
export type Grade = { pass: boolean; files: FileResult[]; typecheck?: boolean };

// The launcher's V8 flags (bin/sandcastle): without them a test child can hit the Node 24 exit deadlock.
const NODE_FLAGS = ["--no-maglev", "--no-concurrent-sparkplug"];
const IDENTITY = ["-c", "user.name=routing-eval", "-c", "user.email=routing-eval@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

/** A copy of `sha` from `repo` with `files` (path -> content) written over it, as a git repository of one commit. */
const materialise = (repo: string, sha: string, files: Record<string, string>) => {
  mkdirSync(join(WORK, "grade"), { recursive: true });
  const dir = mkdtempSync(join(WORK, "grade", "tree-"));
  execFileSync("bash", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "materialise", repo, sha, dir]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  // The kit's dependencies, unless the tree pins others: then its own, from the warm store.
  const same = existsSync(join(dir, "pnpm-lock.yaml")) && readFileSync(join(dir, "pnpm-lock.yaml"), "utf8") === readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8");
  if (same) symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  else execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--silent"], { cwd: dir, stdio: "ignore" });
  // Some tests read the repository they sit in.
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", [...IDENTITY, "commit", "-q", "-m", "tree"], { cwd: dir });
  return dir;
};

const runFile = (dir: string, file: string, limitSeconds: number): FileResult => {
  const tmp = mkdtempSync(join(WORK, "grade", "tmp-"));
  const preloads = ["test/hermetic-env.ts", "test/no-stray.ts"].filter((p) => existsSync(join(dir, p))).flatMap((p) => ["--import", `./${p}`]);
  const [cmd, args] = file.endsWith(".sh")
    ? ["bash", [file]]
    : [process.execPath, [...NODE_FLAGS, ...preloads, "--test", "--test-timeout=120000", "--test-force-exit", file]];
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: limitSeconds * 1000,
    maxBuffer: 32 << 20,
    env: { ...process.env, TMPDIR: tmp, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" },
  });
  rmSync(tmp, { recursive: true, force: true });
  const pass = r.status === 0;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { file, pass, code: r.status, seconds: Math.round((Date.now() - started) / 1000), ...(pass ? {} : { tail: out.split("\n").slice(-15).join("\n") }) };
};

/** The reference's test/ files as they are at its tip - or a probe's at its commit. */
export const overlayOf = (sha: string, paths: string[]) =>
  Object.fromEntries(paths.map((p) => [p, execFileSync("git", ["-C", REPO, "show", `${sha}:${p}`], { encoding: "utf8", maxBuffer: 32 << 20 })]));

/** Grades `sha` of `repo` against `tests` after writing `overlay` over it. */
export const grade = (repo: string, sha: string, overlay: Record<string, string>, tests: string[], { typecheck = false, limitSeconds = 600 } = {}): Grade => {
  const dir = materialise(repo, sha, overlay);
  try {
    const files = tests.map((t) => runFile(dir, t, limitSeconds));
    const tc = typecheck ? spawnSync(join(dir, "node_modules/.bin/tsc"), ["--noEmit"], { cwd: dir, timeout: 300_000 }).status === 0 : undefined;
    return { pass: files.every((f) => f.pass), files, ...(tc === undefined ? {} : { typecheck: tc }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Hidden tests and each probe, for one tree. */
export const gradeTree = (task: Task, repo: string, sha: string, opts?: { typecheck?: boolean }) => ({
  hidden: grade(repo, sha, overlayOf(task.ref, task.overlay), task.hidden, opts),
  probes: (task.probes ?? []).map((p) => ({ commit: p.commit, ...grade(repo, sha, { ...overlayOf(task.ref, task.overlay), ...overlayOf(p.commit, p.overlay) }, p.tests) })),
});
