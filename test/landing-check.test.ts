// The host's check on a landing commit before it fast-forwards the base: one merge of the base
// tip and the gated head, changing nothing beyond a plain merge except under `generated`.
// A temp git repo, no Docker, no model, no network.
//
//   pnpm exec tsx --test test/landing-check.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { checkLandingMerge, landInSandbox } = await import("../src/land.ts");
type Project = import("../src/config.ts").Project;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-landing-check-"));
const generated = [{ paths: ["dist/"], regen: "x" }];
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const write = (root: string, file: string, text: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
};

// main (b) and the branch (h) each change their own file; `c` is a no-ff merge of the two,
// left for the test to add to. `other` is a file neither side touches.
const fixture = () => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  for (const f of ["a.txt", "b.txt", "other.txt"]) write(root, f, "1\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "branch");
  write(root, "b.txt", "2\n");
  git(root, "commit", "-q", "-am", "branch");
  const h = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  write(root, "a.txt", "2\n");
  git(root, "commit", "-q", "-am", "main");
  const b = git(root, "rev-parse", "HEAD");
  const merge = (extra?: () => void) => {
    git(root, "checkout", "-q", "-B", "scratch", b);
    git(root, "merge", "-q", "--no-ff", "--no-commit", h);
    extra?.();
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "land");
    return git(root, "rev-parse", "HEAD");
  };
  return { root, b, h, merge };
};

test("a merge whose extra change is only in a generated path passes", () => {
  const f = fixture();
  assert.equal(checkLandingMerge(f.root, f.merge(() => write(f.root, "dist/app.js", "x\n")), f.b, f.h, generated), undefined);
});

test("a plain merge passes with no generated paths at all", () => {
  const f = fixture();
  assert.equal(checkLandingMerge(f.root, f.merge(), f.b, f.h, []), undefined);
});

test("a merge that also changes a file neither side touched names it", () => {
  const f = fixture();
  const c = f.merge(() => {
    write(f.root, "other.txt", "sneaked\n");
    write(f.root, "dist/app.js", "x\n");
  });
  assert.equal(checkLandingMerge(f.root, c, f.b, f.h, generated), "landing merge changed paths outside generated: other.txt");
});

test("a new file outside generated is named, at most five paths", () => {
  const f = fixture();
  const c = f.merge(() => {
    for (let i = 0; i < 7; i++) write(f.root, `extra${i}.txt`, "x\n");
  });
  assert.equal(
    checkLandingMerge(f.root, c, f.b, f.h, generated),
    "landing merge changed paths outside generated: extra0.txt, extra1.txt, extra2.txt, extra3.txt, extra4.txt",
  );
});

test("a merge that reverts one side's change is caught", () => {
  const f = fixture();
  const c = f.merge(() => write(f.root, "b.txt", "1\n"));
  assert.equal(checkLandingMerge(f.root, c, f.b, f.h, generated), "landing merge changed paths outside generated: b.txt");
});

test("a single-parent commit is not a merge of base and the gated head", () => {
  const f = fixture();
  git(f.root, "checkout", "-q", "-B", "scratch", f.b);
  write(f.root, "dist/app.js", "x\n");
  git(f.root, "add", "-A");
  git(f.root, "commit", "-q", "-m", "land");
  assert.equal(
    checkLandingMerge(f.root, git(f.root, "rev-parse", "HEAD"), f.b, f.h, generated),
    "landing merge is not a merge of base and the gated head",
  );
});

test("parents swapped is not a merge of base and the gated head", () => {
  const f = fixture();
  git(f.root, "checkout", "-q", "-B", "scratch", f.h);
  git(f.root, "merge", "-q", "--no-ff", "-m", "land", f.b);
  assert.equal(
    checkLandingMerge(f.root, git(f.root, "rev-parse", "HEAD"), f.b, f.h, generated),
    "landing merge is not a merge of base and the gated head",
  );
});

// End to end, the sandbox being a host worktree: a `regen` that runs `git add -A` puts a stray
// file into the landing merge, and the base stays where it was.
test("landInSandbox lands nothing when regen stages a file outside generated", async () => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "src.txt", "a\nb\nc\n");
  write(root, "out.txt", "a b c \n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  write(root, "src.txt", "a\nb\nC\n");
  write(root, "out.txt", "a b C \n");
  git(root, "commit", "-q", "-am", "branch");
  const head = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  write(root, "src.txt", "A\nb\nc\n");
  write(root, "out.txt", "A b c \n");
  git(root, "commit", "-q", "-am", "main");
  const mainTip = git(root, "rev-parse", "HEAD");
  const regen = "tr '\\n' ' ' < src.txt > out.txt && echo stray > stray.txt && git add -A";
  const project = { root, baseBranch: "main", generated: [{ paths: ["out.txt"], regen }], setup: [] } as unknown as Project;
  const open: Opener = async (branch) => {
    const path = join(tmp, `wt-${n++}`);
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
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
  const r = await landInSandbox(project, { branch: "agent/issue-7", head, message: "Merge agent/issue-7 (closes #7)" }, open);
  assert.equal(r.kind, "conflict");
  assert.equal((r as { note?: string }).note, "landing merge changed paths outside generated: stray.txt");
  assert.equal(git(root, "rev-parse", "main"), mainTip);
  assert.equal(git(root, "branch", "--list", "sandcastle/land-*"), "");
});
