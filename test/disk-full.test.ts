// A full disk is a message that says so, not a Node stack trace: in the temp directory, which the
// launcher checks before the kit's code runs, and under the project, where any write can hit it. No Docker,
// network or model calls; ENOSPC is simulated (a temp directory that cannot be written, a patched fs).
//
//   pnpm test:file test/disk-full.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runKit } from "./cli-spawn.ts";

const kit = fileURLToPath(new URL("..", import.meta.url));
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-full-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(join(root, "package.json"), '{ "name": "x", "scripts": { "test": "true" } }\n');
  return root;
};
const noStack = (s: string) => assert.ok(!s.split("\n").some((l) => /^\s+at /.test(l)), `stack trace in:\n${s}`);

test("a temp directory that cannot be written: the launcher says so before node starts", () => {
  // A path that does not exist fails as a full disk does, and does so for root too (the Linux check runs as root).
  const r = spawnSync(join(kit, "bin/sandcastle"), ["help"], { cwd: repo(), encoding: "utf8", env: { ...process.env, TMPDIR: "/nonexistent/sandcastle-tmp" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot write to the temp directory \(\/nonexistent\/sandcastle-tmp\) - its disk is full, or it is read-only/);
  noStack(r.stderr);
});

test("ENOSPC under the project: the disk is full, and what frees space", () => {
  const root = repo();
  // The project's .sandcastle cannot be made, as on a full disk; the temp directory still can.
  const preload = join(root, "full.mjs");
  writeFileSync(
    preload,
    'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";\n' +
      'const real = fs.mkdirSync;\n' +
      'fs.mkdirSync = (p, o) => { if (!String(p).includes(".sandcastle")) return real(p, o); throw Object.assign(new Error("ENOSPC: no space left on device, mkdir \'" + p + "\'"), { code: "ENOSPC", path: String(p) }); };\n' +
      "syncBuiltinESMExports();\n",
  );
  // NODE_OPTIONS, so the preload reaches every process the CLI starts.
  const r = runKit(["init"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: `--import ${preload}`, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /The disk is full: writing .*\.sandcastle failed\. Free some space \(`sandcastle clean` removes finished worktrees/);
  noStack(r.stderr);
});
