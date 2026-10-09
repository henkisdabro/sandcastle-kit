// A hook's executable bit: git runs a hook only while it is executable, so `chmod +x` on a disabled
// `.git/hooks/<name>` with the same content enables it without changing a byte. Both the fingerprint
// (checked while sandboxes run) and the start record (checked at the next start) hold the bit, beside
// the content hash. The start record is versioned, and an older one is taken again once, with a line.
// The program-running keys a person's own later git command reads are in the record too. No Docker,
// model calls or network.
//
//   pnpm test:file test/guard-hook-mode.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "../src/config.ts";
import { assertGitConfigBaseline, assertGitUnchanged, gitFingerprint, recordGitConfigEnd, recordGitConfigStart, tookLines } from "../src/guard.ts";
import { quietly } from "./quiet.ts";

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));

const repo = () => {
  const root = join(mkdtempSync(join(tmpdir(), "sandcastle-guard-mode-")), "project");
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  return { project: { root, baseBranch: "main" } as Project, git };
};

const baselinePath = (root: string) => join(root, ".sandcastle", ".run", "git-config-baseline.json");
const start = (project: Project) => recordGitConfigStart(project, assertGitConfigBaseline(project, "sandcastle run"));
const run = async (project: Project) => {
  await quietly(() => {
    start(project);
    recordGitConfigEnd(project);
  });
};
const refusal = (project: Project) => {
  let said = "";
  assert.throws(() => assertGitConfigBaseline(project, "sandcastle run"), (e: Error) => ((said = e.message), said.startsWith("NOT STARTED: ")));
  return said;
};

/** A hook with a plain script body, not executable: git skips it. */
const disabledHook = (root: string, name = "pre-commit") => {
  const path = join(root, ".git", "hooks", name);
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  writeFileSync(path, "#!/bin/sh\ntouch owned\n");
  chmodSync(path, 0o644);
  return path;
};

test("chmod +x on an unchanged disabled hook stops the run, naming the executable bit", () => {
  const { project } = repo();
  const hook = disabledHook(project.root);
  const before = gitFingerprint(project);
  chmodSync(hook, 0o755);
  let said = "";
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), (e: Error) => ((said = e.message), /STOPPED after #1: .*hooks\/pre-commit \(executable bit\) changed while sandboxes ran/.test(said)));
});

test("chmod +x on an unchanged disabled hook in a module's hooks stops the run", () => {
  const { project } = repo();
  const hook = join(project.root, ".git", "modules", "lib", "hooks", "post-checkout");
  mkdirSync(join(project.root, ".git", "modules", "lib", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\ntouch owned\n");
  chmodSync(hook, 0o644);
  const before = gitFingerprint(project);
  chmodSync(hook, 0o755);
  assert.throws(() => assertGitUnchanged(project, before, "after #1"), /modules\/lib\/hooks\/post-checkout \(executable bit\) changed/);
});

test("a hook whose mode and content are unchanged passes the fingerprint check", () => {
  const { project } = repo();
  disabledHook(project.root);
  const before = gitFingerprint(project);
  assert.doesNotThrow(() => assertGitUnchanged(project, before, "after #1"));
});

test("the content hash keeps its form: a hook's entry is the sha-256 of its bytes whatever its mode", () => {
  const { project } = repo();
  const hook = disabledHook(project.root);
  const plain = gitFingerprint(project);
  chmodSync(hook, 0o755);
  const enabled = gitFingerprint(project);
  const path = Object.keys(plain.files).find((f) => f.endsWith("hooks/pre-commit"))!;
  assert.match(plain.files[path], /^[0-9a-f]{64}$/);
  assert.equal(enabled.files[path], plain.files[path]);
  assert.notEqual(enabled.modes[path], plain.modes[path]);
});

test("chmod +x on an unchanged disabled hook between two runs is refused at the next start", async () => {
  const { project } = repo();
  const hook = disabledHook(project.root);
  await run(project);
  chmodSync(hook, 0o755);
  const said = refusal(project);
  assert.match(said, /Under \.git\/: hooks\/pre-commit executable bit changed/);
  assert.match(said, /Something wrote them between the runs/);
});

test("a hook manager's marker does not excuse an executable bit changed on an existing hook", async () => {
  const { project } = repo();
  const hook = join(project.root, ".git", "hooks", "pre-commit");
  mkdirSync(join(project.root, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/usr/bin/env bash\n# husky\nexit 0\n");
  chmodSync(hook, 0o644);
  await run(project);
  chmodSync(hook, 0o755);
  assert.match(refusal(project), /executable bit changed/);
});

test("an unchanged hook at start and end leaves the next start quiet", async () => {
  const { project } = repo();
  disabledHook(project.root);
  await run(project);
  const { lines } = await quietly(() => start(project));
  assert.deepEqual(lines, []);
});

test("each program-running key a person's later git command reads is recorded and refused when set between runs", async () => {
  const keys: [string, string][] = [
    ["pager.log", "touch owned"],
    ["alias.st", "!touch owned"],
    ["difftool.x.cmd", "touch owned"],
    ["mergetool.x.cmd", "touch owned"],
    ["submodule.lib.update", "!touch owned"],
    ["interactive.diffFilter", "touch owned"],
    ["gpg.ssh.defaultKeyCommand", "touch owned"],
    ["core.alternateRefsCommand", "touch owned"],
    ["lfs.customtransfer.x.path", "touch owned"],
    ["lfs.url", "https://example.invalid/lfs"],
  ];
  for (const [key, value] of keys) {
    const { project, git } = repo();
    await run(project);
    git("config", key, value);
    const said = refusal(project);
    assert.match(said, new RegExp(`In \\.git/config: ${key.replace(/\./g, "\\.")} added`, "i"), key);
    // The value is the sandbox's to choose: a program is not printed.
    assert.doesNotMatch(said, /touch owned/, key);
  }
});

test("a record with no version is taken again once, with a line and no refusal, and then compared", async () => {
  const { project, git } = repo();
  git("config", "alias.st", "status");
  git("config", "pager.log", "less");
  mkdirSync(join(project.root, ".sandcastle", ".run"), { recursive: true });
  // What the previous version wrote: its keys, hooks and attributes, no version and no executable bits.
  writeFileSync(baselinePath(project.root), `${JSON.stringify({ entries: [], worktreeEntries: [], attributes: "", files: {}, clean: true })}\n`);
  const { lines } = await quietly(() => start(project));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /taken again from the present state, once/);
  const record = JSON.parse(readFileSync(baselinePath(project.root), "utf8"));
  assert.equal(record.version, 2);
  assert.ok(record.entries.some((e: string) => e.startsWith("alias.st\n")));
  recordGitConfigEnd(project);
  // From here the record is current: the line is not printed again, and a change is refused.
  assert.deepEqual((await quietly(() => start(project))).lines, []);
  git("config", "alias.co", "!touch owned");
  assert.match(refusal(project), /alias\.co added/);
});

test("an older version's record is taken again without a refusal even when the config differs from it", async () => {
  const { project, git } = repo();
  git("config", "core.fsmonitor", "touch owned");
  mkdirSync(join(project.root, ".sandcastle", ".run"), { recursive: true });
  writeFileSync(baselinePath(project.root), `${JSON.stringify({ version: 1, entries: [], worktreeEntries: [], attributes: "", files: {}, modes: {}, clean: false })}\n`);
  const { lines } = await quietly(() => assert.doesNotThrow(() => start(project)));
  assert.equal(lines.length, 1);
});

test("a detached start shows the line of an older record taken again on its own terminal, as the child's log does", async () => {
  const { project } = repo();
  mkdirSync(join(project.root, ".sandcastle", ".run"), { recursive: true });
  writeFileSync(baselinePath(project.root), `${JSON.stringify({ entries: [], worktreeEntries: [], attributes: "", files: {}, clean: true })}\n`);
  // The `--detach` parent's check records nothing and prints `tookLines` of it: the child's start prints the same.
  const parent = tookLines(assertGitConfigBaseline(project, "sandcastle run"));
  assert.equal(parent.length, 1);
  assert.match(parent[0], /taken again from the present state, once/);
  assert.deepEqual((await quietly(() => start(project))).lines, parent);
});

test("a first run, with no record, prints no line", async () => {
  const { project } = repo();
  assert.deepEqual((await quietly(() => start(project))).lines, []);
});
