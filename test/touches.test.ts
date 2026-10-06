// The Touches line: parsing, glob expansion against a temp repo, and the files git cannot merge.
//
//   node --test test/touches.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const { expandTouches, parseTouches, unmergeable } = await import("../src/touches.ts");

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-touches-"));
  git(dir, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
};

test("parseTouches: one line, split on commas, trimmed", () => {
  assert.deepEqual(parseTouches("## Problem\n\nx\n\nTouches: src/a.ts,  ./src/b/**/*.ts , docs/\n\n## Fix"), [
    "src/a.ts",
    "src/b/**/*.ts",
    "docs/",
  ]);
});

test("parseTouches: a second line is merged into the first, once each", () => {
  assert.deepEqual(parseTouches("Touches: a.ts, b.ts\ntext\ntouches: b.ts, c.ts"), ["a.ts", "b.ts", "c.ts"]);
});

test("parseTouches: a line inside a fence or backticks is ignored", () => {
  assert.deepEqual(parseTouches("```\nTouches: src/a.ts\n```\n"), []);
  assert.deepEqual(parseTouches("Write `Touches: src/a.ts` like this"), []);
  assert.deepEqual(parseTouches("```\nTouches: src/a.ts\n```\nTouches: src/b.ts"), ["src/b.ts"]);
});

test("parseTouches: no line, or an empty one, is []", () => {
  assert.deepEqual(parseTouches(""), []);
  assert.deepEqual(parseTouches("Problem: it touches things\nNot Touches: x"), []);
  assert.deepEqual(parseTouches("Touches:  \n"), []);
});

test("expandTouches: globs match the tree at the ref, * stays in a directory, ** does not", () => {
  const dir = repo({ "src/a.ts": "a", "src/b.js": "b", "src/deep/c.ts": "c", "docs/x.md": "x", "top.ts": "t" });
  assert.deepEqual(expandTouches(dir, "HEAD", ["src/*.ts"]), ["src/a.ts"]);
  assert.deepEqual(expandTouches(dir, "HEAD", ["src/**/*.ts"]).sort(), ["src/a.ts", "src/deep/c.ts"]);
  assert.deepEqual(expandTouches(dir, "HEAD", ["**/*.ts"]).sort(), ["src/a.ts", "src/deep/c.ts", "top.ts"]);
  assert.deepEqual(expandTouches(dir, "HEAD", ["src/", "docs/x.md", "src/a.ts"]).sort(), [
    "docs/x.md",
    "src/a.ts",
    "src/b.js",
    "src/deep/c.ts",
  ]);
});

test("expandTouches: a path that does not exist yet is kept as written, a dead glob is dropped", () => {
  const dir = repo({ "src/a.ts": "a" });
  assert.deepEqual(expandTouches(dir, "HEAD", ["src/new.ts", "newdir/", "nothing/**/*.ts"]), ["src/new.ts", "newdir"]);
  assert.deepEqual(expandTouches(dir, "no-such-ref", ["src/a.ts"]), ["src/a.ts"]);
});

test("unmergeable: lockfiles, in the root or a subdirectory", () => {
  const dir = repo({ "pnpm-lock.yaml": "x", "web/bun.lockb": "x", "go.sum": "x", "pnpm-lock.yaml.md": "x", "src/a.ts": "x" });
  for (const f of ["pnpm-lock.yaml", "web/bun.lockb", "go.sum", "package-lock.json", "yarn.lock", "bun.lock", "Cargo.lock", "poetry.lock", "uv.lock", "Gemfile.lock"]) {
    assert.ok(unmergeable(dir, "HEAD", f, []), f);
  }
  assert.ok(!unmergeable(dir, "HEAD", "pnpm-lock.yaml.md", []));
  assert.ok(!unmergeable(dir, "HEAD", "src/a.ts", []));
});

test("unmergeable: a path covered by a generated entry", () => {
  const dir = repo({ "dist/app.js": "x\ny\nz\nw\n", "src/a.ts": "x\ny\nz\nw\n" });
  const generated = [{ paths: ["dist/", "data.json"], regen: "build" }];
  assert.ok(unmergeable(dir, "HEAD", "dist/app.js", generated));
  assert.ok(unmergeable(dir, "HEAD", "data.json", generated));
  assert.ok(!unmergeable(dir, "HEAD", "src/a.ts", generated));
});

test("unmergeable: a big blob of at most 3 lines is minified, others are not", () => {
  const dir = repo({
    "min.js": "a".repeat(2000),
    "min3.js": ("a".repeat(1000) + "\n").repeat(3),
    "four.js": ("a".repeat(1000) + "\n").repeat(4),
    "small.js": "a".repeat(1999),
  });
  assert.ok(unmergeable(dir, "HEAD", "min.js", []));
  assert.ok(unmergeable(dir, "HEAD", "min3.js", []));
  assert.ok(!unmergeable(dir, "HEAD", "four.js", []));
  assert.ok(!unmergeable(dir, "HEAD", "small.js", []));
  assert.ok(!unmergeable(dir, "HEAD", "not-there.js", []));
});

test("unmergeable: reads the blob at the ref, not the working tree", () => {
  const dir = repo({ "a.js": ("a".repeat(100) + "\n").repeat(50) });
  writeFileSync(join(dir, "a.js"), "a".repeat(5000));
  assert.ok(!unmergeable(dir, "HEAD", "a.js", []));
});
