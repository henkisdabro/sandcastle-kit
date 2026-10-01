// The landing preview (src/preview.ts) against a temp git repo. The Runner runs the real
// PREVIEW_SCRIPT on the host, so no Docker, no model calls, no network.
//
//   pnpm exec tsx --test test/preview.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { type PreviewRow, type Runner, preview, previewLines, unlanded } from "../src/preview.ts";

// Inside a sandbox the kit sets GIT_COMMITTER_* (AGENT_COMMITTER), which beats `-c user.name`;
// drop every identity variable so the commits here are T's wherever the suite runs.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

// `merge-tree --write-tree` needs git 2.38 on the host that runs the script under test.
const gitTooOld = (() => {
  const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
  return !m || Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 38);
})();

const hostRunner: Runner = (script, args, dirs) =>
  spawnSync("sh", ["-c", script, "sh", ...args], {
    env: { ...env, REPO_GIT: dirs.gitDir, SCRATCH: dirs.scratch },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const lines = (n: string) => [`${n}1`, `${n}2`, `${n}3`].join("\n") + "\n";

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-preview-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  git("config", "commit.gpgsign", "false");
  // The kit's own .sandcastle/.run is gitignored in a project; so is it here.
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  for (const f of ["a", "b", "c"]) writeFileSync(join(root, `${f}.txt`), lines(f));
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  return { project: { root, baseBranch: "main" } as Project, git, root };
};

// A branch from main whose tip is dated, so the landing order is fixed.
const branch = (r: ReturnType<typeof repo>, name: string, day: number, edits: Record<string, string>) => {
  r.git("checkout", "-q", "-b", name, "main");
  for (const [file, first] of Object.entries(edits)) {
    writeFileSync(join(r.root, file), readFileSync(join(r.root, file), "utf8").replace(/^.*/, first));
  }
  r.git("add", "-A");
  const date = `2024-01-${String(day).padStart(2, "0")}T12:00:00Z`;
  execFileSync("git", ["-C", r.root, "commit", "-q", "-m", name], { env: { ...env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  r.git("checkout", "-q", "main");
};

const fixture = () => {
  const r = repo();
  branch(r, "agent/issue-1", 1, { "a.txt": "A1" });
  branch(r, "agent/issue-2", 2, { "a.txt": "A2", "c.txt": "C2" });
  branch(r, "agent/issue-3", 3, { "b.txt": "B3" });
  branch(r, "agent/issue-4", 4, { "c.txt": "C4" });
  branch(r, "agent/issue-6", 5, { "b.txt": "B6" });
  // Already merged into main: nothing to land.
  r.git("checkout", "-q", "-b", "agent/issue-5", "main");
  writeFileSync(join(r.root, "d.txt"), "D5\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "five");
  r.git("checkout", "-q", "main");
  r.git("merge", "-q", "--ff-only", "agent/issue-5");
  branch(r, "agent/other", 6, { "a.txt": "O" });
  return r;
};

const objects = (root: string) => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));
  return walk(join(root, ".git/objects")).sort();
};

test("unlanded lists the agent/issue-* branches with commits past the base, oldest tip first", () => {
  const r = fixture();
  assert.deepEqual(
    unlanded(r.project).map((b) => b.id),
    ["1", "2", "3", "4", "6"],
  );
  assert.equal(unlanded(r.project)[0].branch, "agent/issue-1");
  assert.equal(unlanded(r.project)[0].head, r.git("rev-parse", "agent/issue-1"));
});

// Name order would put issue-10 before issue-9; the older tip goes first all the same.
test("unlanded orders by the tip's committer date before the name", () => {
  const r = repo();
  branch(r, "agent/issue-10", 2, { "a.txt": "A10" });
  branch(r, "agent/issue-9", 1, { "b.txt": "B9" });
  assert.deepEqual(
    unlanded(r.project).map((b) => b.id),
    ["9", "10"],
  );
});

test("preview merges each clean branch onto the last and leaves a conflicting one out", (t) => {
  if (gitTooOld) return t.skip("host git older than 2.38");
  const r = fixture();
  const rows = preview(r.project, hostRunner);
  assert.deepEqual(
    rows.map((x) => [x.id, x.result, x.files]),
    [
      ["1", "clean", []],
      ["2", "conflict", ["a.txt"]],
      ["3", "clean", []],
      ["4", "clean", []],
      ["6", "conflict", ["b.txt"]],
    ],
  );
});

test("preview writes nothing to the repo and removes its scratch directory", (t) => {
  if (gitTooOld) return t.skip("host git older than 2.38");
  const r = fixture();
  const before = objects(r.root);
  preview(r.project, hostRunner);
  assert.deepEqual(objects(r.root), before);
  assert.equal(r.git("status", "--porcelain"), "");
  const run = join(r.root, ".sandcastle/.run");
  assert.deepEqual(existsSync(run) ? readdirSync(run).filter((f) => f.startsWith("preview-")) : [], []);
});

test("previewLines gives the exact report", () => {
  const r = repo();
  const at = r.git("rev-parse", "--short", "main");
  const row = (id: string, result: PreviewRow["result"], files: string[] = [], detail?: string): PreviewRow => ({ branch: `agent/issue-${id}`, id, head: "x", result, files, detail });
  assert.deepEqual(
    previewLines(r.project, "main", [row("12", "clean"), row("15", "conflict", ["src/a.css", "data/x.json"]), row("18", "error", [], "boom")]),
    [
      `Landing preview: 3 unlanded branch(es) against main at ${at}, oldest first. Nothing is merged.`,
      "  clean     #12  agent/issue-12",
      "  CONFLICT  #15  agent/issue-15: src/a.css, data/x.json",
      "  ERROR     #18  agent/issue-18: boom",
      "A conflicting branch is left out of the merges after it, as landing would leave it out.",
      "1 clean, 1 conflicting, 1 failed to preview.",
    ],
  );
  const seven = previewLines(r.project, "main", [row("1", "conflict", ["1", "2", "3", "4", "5", "6", "7"])]);
  assert.equal(seven[1], "  CONFLICT  #1  agent/issue-1: 1, 2, 3, 4, 5 and 2 more");
  assert.equal(seven.at(-1), "1 conflicting.");
  assert.deepEqual(previewLines(r.project, "main", []), ["No unlanded agent/issue-* branches."]);
});

test("a runner that fails is an operator error; no branches never calls the runner", () => {
  const r = fixture();
  const failing: Runner = () => ({ status: 125, stdout: "", stderr: "Unable to find image" });
  assert.throws(() => preview(r.project, failing), /could not run in the image: Unable to find image/);
  const none = repo();
  mkdirSync(join(none.root, ".sandcastle"), { recursive: true });
  let called = false;
  assert.deepEqual(
    preview(none.project, () => ((called = true), { status: 0, stdout: "", stderr: "" })),
    [],
  );
  assert.equal(called, false);
});
