// The CLI's one catch: a refusal the operator acts on prints a message and exits 1, with no stack
// trace; the commands run in a throwaway repo, no Docker and no model calls.
//
//   node --test test/cli.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";


const temp = () => mkdtempSync(join(tmpdir(), "sandcastle-cli-"));
const repo = () => {
  const root = temp();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
};
const sandcastle = (cwd: string, ...args: string[]) =>
  runKit([...args], {
    cwd,
    encoding: "utf8",
    // Never discover a repository above the throwaway directory.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
  });

const refused = (r: ReturnType<typeof sandcastle>, message: string) => {
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(message), r.stderr);
  assert.ok(!r.stderr.split("\n").some((l) => /^\s+at /.test(l)), `stack trace in:\n${r.stderr}`);
};

test("an unknown command is a message, not a stack trace", () => {
  refused(sandcastle(repo(), "no-such-command"), 'Unknown command "no-such-command"');
});

test("a project with no config is told to run init, with no stack trace", () => {
  refused(sandcastle(repo(), "queue"), "Run `sandcastle init` first");
});

test("outside a git repository is a message, not a stack trace", () => {
  const dir = join(temp(), "plain");
  mkdirSync(dir);
  refused(sandcastle(dir, "queue"), "Not inside a git repository");
});

test("init on an existing config is a message, not a stack trace", () => {
  const root = repo();
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), "export default {};\n");
  refused(sandcastle(root, "init"), "already exists");
});
