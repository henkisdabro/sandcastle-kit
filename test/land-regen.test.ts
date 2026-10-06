// Landing a branch whose conflict is only in generated files: the merge is redone in a
// throwaway sandbox, resolved by regenerating, and the host base is fast-forwarded. The
// sandbox is a host worktree here - no Docker, no model, no network.
//
//   node --test test/land-regen.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { landInSandbox } = await import("../src/land.ts");
const { OperatorError } = await import("../src/errors.ts");
const { closeComment } = await import("../src/burndown.ts");
type Project = import("../src/config.ts").Project;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-land-"));
const REGEN = "tr '\\n' ' ' < src.txt > out.txt";
const MESSAGE = "Merge agent/issue-7 (closes #7)";
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};

// main changes line 1 of src.txt, agent/issue-7 line 3 (and line 2 on both sides when `both`);
// each regenerates out.txt, so merging one into the other conflicts in out.txt.
const fixture = (regen: string, both = false) => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "src.txt"), "a\nb\nc\n");
  spawnSync("sh", ["-c", REGEN], { cwd: root });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  writeFileSync(join(root, "src.txt"), `a\n${both ? "B1" : "b"}\nC\n`);
  spawnSync("sh", ["-c", REGEN], { cwd: root });
  git(root, "commit", "-q", "-am", "branch");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "src.txt"), `A\n${both ? "B2" : "b"}\nc\n`);
  spawnSync("sh", ["-c", REGEN], { cwd: root });
  git(root, "commit", "-q", "-am", "main");
  const project = { root, baseBranch: "main", generated: [{ paths: ["out.txt"], regen }], setup: [] } as unknown as Project;
  const open: Opener = async (branch) => {
    const path = join(tmp, `wt-${n++}`);
    assert.equal(git(root, "worktree", "add", "-q", "-b", branch, path, "main").status, 0);
    return {
      worktreePath: path,
      // execGate wraps commands in `timeout -k n n`, which macOS lacks.
      exec: async (cmd) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => git(root, "worktree", "remove", "--force", path),
    };
  };
  const head = git(root, "rev-parse", "agent/issue-7").out;
  const mainTip = git(root, "rev-parse", "main").out;
  return { root, project, open, head, mainTip };
};

const land = (f: ReturnType<typeof fixture>) => landInSandbox(f.project, { branch: "agent/issue-7", head: f.head, message: MESSAGE }, f.open);
const scratchBranches = (root: string) => git(root, "branch", "--list", "sandcastle/land-*").out;

test("a conflict only in generated files lands by regenerating them", async () => {
  const f = fixture(REGEN);
  const r = await land(f);
  assert.equal(r.kind, "merged");
  const { commit, files, regen } = r as { commit: string; files: string[]; regen: string[] };
  assert.deepEqual(files, ["out.txt"]);
  assert.deepEqual(regen, [REGEN]);
  assert.equal(git(f.root, "rev-parse", "main").out, commit);
  assert.equal(git(f.root, "log", "-1", "--format=%s", "main").out, MESSAGE);
  assert.equal(git(f.root, "rev-parse", "main^1").out, f.mainTip);
  assert.equal(git(f.root, "rev-parse", "main^2").out, f.head);
  assert.equal(readFileSync(join(f.root, "out.txt"), "utf8"), "A b C ");
  assert.equal(scratchBranches(f.root), "");
  assert.equal(git(f.root, "status", "--porcelain").out, "");
});

test("a conflict also in a source file stays a conflict", async () => {
  const f = fixture(REGEN, true);
  const r = await land(f);
  assert.equal(r.kind, "conflict");
  assert.ok((r as { files: string[] }).files.includes("src.txt"));
  assert.equal(git(f.root, "rev-parse", "main").out, f.mainTip);
  assert.equal(scratchBranches(f.root), "");
});

test("a failing regen is reported and the base stays where it was", async () => {
  const f = fixture("exit 3");
  const r = await land(f);
  assert.equal(r.kind, "regen-failed");
  assert.match((r as { reason: string }).reason, /exited 3/);
  assert.equal(git(f.root, "rev-parse", "main").out, f.mainTip);
  assert.equal(scratchBranches(f.root), "");
});

test("a sandbox that wrote the shared .git/config stops the run and lands nothing", async () => {
  const f = fixture(`${REGEN} && git config --local sandcastle.test 1`);
  await assert.rejects(land(f), (e: Error) => e instanceof OperatorError && /STOPPED/.test(e.message));
  assert.equal(git(f.root, "rev-parse", "main").out, f.mainTip);
});

test("closeComment names the regenerated files, and is unchanged without them", () => {
  const o = { branch: "agent/issue-7", commits: 2, repairs: 0 };
  const plain = closeComment(o, "test");
  const text = closeComment({ ...o, regenerated: { files: ["out.txt"], regen: ["make css"] } }, "test");
  assert.ok(text.includes("Conflicts in generated files (out.txt) were resolved by running `make css`."));
  assert.equal(
    plain,
    "Merged locally, not yet pushed, by the Sandcastle loop from `agent/issue-7` (2 commit(s)); test all green before merge.",
  );
  assert.equal(text, plain.replace("before merge.", "before merge. Conflicts in generated files (out.txt) were resolved by running `make css`."));
});
