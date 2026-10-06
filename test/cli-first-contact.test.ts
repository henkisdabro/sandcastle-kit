// What a newcomer sees first, outside any repository: git's "fatal: not a git repository" printed
// above every command (help included), and a typo answered with "Not inside a git repository".
// The help prints clean, and an unknown command is named as one, with the nearest real command.
//
//   node --test test/cli-first-contact.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const outside = mkdtempSync(join(tmpdir(), "sc-first-"));
const cli = (...args: string[]) =>
  spawnSync(join(KIT, "bin/sandcastle"), args, { cwd: outside, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: outside } });

test("help outside a repository has no git error above it", () => {
  const r = cli("help");
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /fatal:/);
  assert.match(r.stdout, /^sandcastle <command>/);
});

test("a typo is named as one, with the nearest command", () => {
  const r = cli("stauts");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command "stauts"\. Did you mean `sandcastle status`\?/);
  assert.doesNotMatch(r.stderr, /fatal:|not inside a git repository|    at /i);
});

test("an unknown word gets no guess", () => {
  const r = cli("frobnicate");
  assert.match(r.stderr, /Unknown command "frobnicate"\. Run `sandcastle help`/);
  assert.doesNotMatch(r.stderr, /Did you mean/);
});

test("a real command outside a repository says so, without git's error", () => {
  const r = cli("status", "0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Not inside a git repository/);
  assert.doesNotMatch(r.stderr, /fatal:/);
});
