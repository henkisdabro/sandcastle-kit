// `unmergeable` reads file sizes from one `git ls-tree -r -l` per commit, not one `git cat-file`
// per path, so a broad `Touches: src/` line over a large repo is not thousands of spawns. A `git`
// shim on PATH logs each call and runs the real git.
//
// The shim is a POSIX sh script (macOS and Linux both have `sh`) and the paths come from
// os.tmpdir() and node:path, so the test runs the same on both.
//
//   pnpm test:file test/touches-tree.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const { expandTouches, unmergeableFiles } = await import("../src/touches.ts");

const run = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

const MINIFIED = `${"var a=function(b){return b+1};".repeat(100)}\n`;
const BIG_READABLE = "const a = 1;\n".repeat(300);

test("a Touches: src/ line over 2,000 files reads the tree once, and blobs only for the big ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-tree-"));
  run(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  for (let i = 0; i < 2000; i++) writeFileSync(join(dir, "src", `f${i}.ts`), `export const n = ${i};\n`);
  writeFileSync(join(dir, "src", "bundle.min.js"), MINIFIED);
  writeFileSync(join(dir, "src", "long.ts"), BIG_READABLE);
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lock\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");

  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-shim-"));
  const log = join(bin, "calls.log");
  writeFileSync(log, "");
  // Each call's arguments go on one line of the log; the path is quoted so a space in it survives.
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);

  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before}`;
  try {
    const files = expandTouches(dir, "main", ["src/"]);
    assert.equal(files.length, 2002);
    const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
    const expandCalls = calls().length;
    const hard = unmergeableFiles(dir, "main", [...files, "pnpm-lock.yaml"], []);
    assert.deepEqual([...hard].sort(), ["pnpm-lock.yaml", "src/bundle.min.js"]);
    const mine = calls().slice(expandCalls);
    assert.equal(mine.filter((c) => c.includes("ls-tree")).length, 1, mine.join("\n"));
    assert.equal(mine.filter((c) => c.includes("cat-file -s")).length, 0, "no size read per file");
    // Only the two files at least 2,000 bytes long are read.
    assert.equal(mine.filter((c) => c.includes("cat-file blob")).length, 2, mine.join("\n"));
    // A second ask for the same commit reads no tree.
    unmergeableFiles(dir, "main", files, []);
    assert.equal(calls().slice(expandCalls + mine.length).filter((c) => c.includes("ls-tree")).length, 0);
  } finally {
    process.env.PATH = before;
  }
});

test("the tree is cached per commit: a branch that moves is read again", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-tree-"));
  run(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.js"), "var a = 1;\n".repeat(300));
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  assert.deepEqual(unmergeableFiles(dir, "main", ["app.js"], []), []);
  writeFileSync(join(dir, "app.js"), MINIFIED);
  run(dir, "commit", "-q", "-am", "minify");
  assert.deepEqual(unmergeableFiles(dir, "main", ["app.js"], []), ["app.js"]);
});

test("a ref that does not exist, and a path that is not in the tree, are not unmergeable", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-tree-"));
  run(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  assert.deepEqual(unmergeableFiles(dir, "nope", ["a.txt", "yarn.lock"], []), ["yarn.lock"]);
  assert.deepEqual(unmergeableFiles(dir, "main", ["new.min.js"], []), []);
});
