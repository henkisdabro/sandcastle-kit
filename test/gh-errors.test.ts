// A gh failure (signed out, no such issue) is a one-line refusal from the CLI, never a stack
// trace. A fake gh on PATH; a throwaway repo; no Docker, network or model calls.
//
//   node --test test/gh-errors.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";


const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), 'export default { name: "t", setup: [], gates: [{ name: "ok", command: "true" }] };\n');
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'GraphQL: Could not resolve to an issue or pull request with the number of 999. (repository.issue)' >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(root, ".gitignore"), "bin/\n");
  // A clean tree, as `land` requires one before it asks the tracker anything.
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { root, bin };
};

// runKit (test/cli-spawn.ts) starts process.execPath, not bin/sandcastle: a mise or asdf node shim
// breaks once the environment moves (see .sandcastle/rules.md).
const sandcastle = (p: { root: string; bin: string }, ...args: string[]) =>
  runKit([...args], {
    cwd: p.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${p.bin}${delimiter}${process.env.PATH}`, GIT_CEILING_DIRECTORIES: tmpdir() },
  });

for (const args of [["requeue", "999", "--note", "x"], ["land", "999"], ["queue"]]) {
  test(`sandcastle ${args.join(" ")} with gh failing is a message, not a stack trace`, () => {
    const r = sandcastle(project(), ...args);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /gh \S+ \S+ failed: GraphQL: Could not resolve/);
    assert.ok(!r.stderr.split("\n").some((l) => /^\s+at /.test(l)), `stack trace in:\n${r.stderr}`);
  });
}

test("no GitHub remote: the refusal says how to add one or use ticket files, and gh's raw line is not echoed", () => {
  const p = project();
  writeFileSync(join(p.bin, "gh"), "#!/bin/sh\necho 'no git remotes found' >&2\nexit 1\n");
  const r = sandcastle(p, "queue");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no git remotes found - this repository has no GitHub remote.*`git remote add origin <url>`.*`tracker: "files"`/);
  // Once, in the kit's line: sh() captures a child's stderr rather than passing it through.
  assert.equal(r.stderr.split("no git remotes found").length - 1, 1, r.stderr);
});

// gh's own words for a dropped network or a signed-out token name no way out; the kit's line does.
for (const [said, fix] of [
  ['Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host', /GitHub could not be reached\. Check the network \(or proxy\)/],
  ["HTTP 401: Bad credentials (https://api.github.com/graphql)", /gh is not signed in to GitHub: `gh auth status` says why, `gh auth login` signs it in/],
  ["something gh has never said before", /`sandcastle doctor` checks gh's sign-in and the GitHub remote/],
] as const) {
  test(`gh failing with "${said.slice(0, 40)}" says what to do next`, () => {
    const p = project();
    writeFileSync(join(p.bin, "gh"), `#!/bin/sh\necho '${said}' >&2\nexit 1\n`);
    const r = sandcastle(p, "queue");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, fix);
  });
}
