// The kit's own pre-commit hook, as a contributor who clones the kit gets it: a denylist with a
// comment or a blank line blocked every commit (an empty pattern matches any line), naming the
// harmless line as the hit. A stand-in gitleaks; a temp repo; no network.
//
//   pnpm test:file test/precommit-hook.test.ts

import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");

const setup = (denylist: string, allowlist?: string) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-hook-"));
  const bin = join(root, ".bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gitleaks"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "gitleaks"), 0o755);
  mkdirSync(join(root, ".githooks"));
  copyFileSync(join(KIT, ".githooks/pre-commit"), join(root, ".githooks/pre-commit"));
  chmodSync(join(root, ".githooks/pre-commit"), 0o755);
  const config = join(root, ".config");
  mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
  writeFileSync(join(config, "sandcastle-kit/denylist"), denylist);
  if (allowlist !== undefined) writeFileSync(join(config, "sandcastle-kit/allowlist"), allowlist);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, XDG_CONFIG_HOME: config };
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: root, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "core.hooksPath", ".githooks");
  const commit = (line: string) => {
    writeFileSync(join(root, "f.txt"), `${line}\n`);
    git("add", "f.txt");
    return git("commit", "-qm", "t");
  };
  return { commit };
};

test("comments and blank lines in the denylist are skipped; a listed name still blocks", () => {
  const { commit } = setup("# my private names\n\n  \nsecretclientname\n");
  assert.equal(commit("a harmless line").status, 0);
  const r = commit("SecretClientName in a comment");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /staged lines match your personal denylist/);
});

// A maintainer's own name is on their denylist, yet an author credit they mean to publish
// carries it. The allowlist lets that one line through, not the name everywhere.
test("a line the allowlist matches passes; the name anywhere else still blocks", () => {
  const { commit } = setup("jane doe\njanedoe\\.example\n", "# my author credit\n\nutm_campaign=oss-example\n");
  assert.equal(commit('Built by <a href="https://janedoe.example/?utm_campaign=oss-example">Jane Doe</a>').status, 0);
  const r = commit("thanks to Jane Doe for the fix");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Jane Doe/);
});

test("a denylist of only comments blocks nothing", () => {
  const { commit } = setup("# nothing yet\n");
  assert.equal(commit("anything at all").status, 0);
});
