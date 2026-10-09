// The git guard's branch rule looks at one command only: a later command in the same line (a
// `git merge --no-ff`, whose `-ff` looks like `-f`) must not make `git branch` a refused delete.
//
//   pnpm test:file test/git-guard-branch-scope.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "../src/sandbox.ts";

const GUARD = join(KIT, "container/git-guard.sh");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const bash = (command: string) =>
  spawnSync("bash", [GUARD], { input: JSON.stringify({ cwd: KIT, tool_input: { command } }), encoding: "utf8", env });

const ALLOWED = [
  "git branch x; git merge --no-ff agent/y",
  "git branch agent/issue-7; git merge -q --no-ff -m m agent/issue-7",
  "git branch x && git merge --no-ff agent/y",
  "git branch x || git merge --no-ff agent/y",
  "git branch x | git merge --no-ff agent/y",
  "git branch x\ngit merge --no-ff agent/y",
];

const BLOCKED = [
  "git branch -D agent/y",
  "git branch -f agent/y HEAD",
  "git branch --delete agent/y",
  "git branch --force agent/y HEAD",
  "cd x && git branch -D agent/y",
  "git branch x; git branch -D agent/y",
];

for (const command of ALLOWED) {
  test(`allowed: ${JSON.stringify(command)}`, () => {
    const r = bash(command);
    assert.equal(r.status, 0, r.stderr);
  });
}

for (const command of BLOCKED) {
  test(`blocked: ${JSON.stringify(command)}`, () => {
    const r = bash(command);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /deleting or moving an agent branch/);
  });
}
