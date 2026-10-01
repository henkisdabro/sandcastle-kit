// `land: "squash"`: the landing commit, how a conflict is undone, the config key and the status
// view of a branch that landing deleted. Temp git repos, a fake `sandcastle` and `docker` on PATH;
// no Docker, no gh, no network.
//
//   pnpm exec tsx --test test/land-squash.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// sandbox.ts derives USER_CONFIG from this at import: nothing here may read the user's real config.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// mergeBranch passes process.env through to git, so an exported identity would win over config there too.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { mergeBranch, abortLanding } = await import("../src/burndown.ts");
const { loadProject } = await import("../src/config.ts");
const { OperatorError } = await import("../src/errors.ts");

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-land-squash-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "start.txt", "start\n", "start");
  return root;
};
// main: start. agent/issue-7: two work commits, then main moves on and is merged into the branch.
const fixture = () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  commitFile(root, "a.txt", "a\n", "add a");
  commitFile(root, "b.txt", "b\n", "add b");
  git(root, "checkout", "-q", "main");
  commitFile(root, "other.txt", "other\n", "main moves on");
  git(root, "checkout", "-q", "agent/issue-7");
  git(root, "merge", "--no-ff", "-q", "-m", "Merge branch 'main' into agent/issue-7", "main");
  const tip = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  return { root, tip };
};
const SUBJECT = "Merge agent/issue-7 (closes #7)";

test("squash lands one commit with the merge subject, the work subjects as a body and the branch's tree", () => {
  const { root, tip } = fixture();
  const before = Number(git(root, "rev-list", "--count", "main"));
  mergeBranch(root, "agent/issue-7", tip, "#7", "squash");
  assert.equal(Number(git(root, "rev-list", "--count", "main")), before + 1);
  assert.equal(git(root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 2, "one parent");
  assert.equal(git(root, "log", "-1", "--format=%s"), SUBJECT);
  assert.equal(git(root, "log", "-1", "--format=%b"), "- add a\n- add b");
  assert.equal(spawnSync("git", ["diff", "--quiet", "HEAD", "agent/issue-7"], { cwd: root }).status, 0, "same tree");
  assert.equal(git(root, "log", "-1", "--format=%cn"), "Sandcastle agent");
  assert.equal(git(root, "log", "-1", "--format=%an"), "Operator Example");
  assert.equal(git(root, "status", "--porcelain"), "");
  // What `mergedEarlier` and status.sh look for.
  assert.equal(git(root, "log", "main", "-1", "--format=%h", "--fixed-strings", `--grep=${SUBJECT}`), git(root, "rev-parse", "--short", "HEAD"));
});

test("merge stays the default: two parents, the same subject", () => {
  const { root, tip } = fixture();
  mergeBranch(root, "agent/issue-7", tip, "#7");
  assert.equal(git(root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "two parents");
  assert.equal(git(root, "log", "-1", "--format=%s"), SUBJECT);
});

test("a squash of a change the base already holds still commits, so the ticket reads as landed", () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  commitFile(root, "a.txt", "a\n", "add a");
  const tip = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  commitFile(root, "a.txt", "a\n", "add a on main");
  const before = Number(git(root, "rev-list", "--count", "main"));
  mergeBranch(root, "agent/issue-7", tip, "#7", "squash");
  assert.equal(Number(git(root, "rev-list", "--count", "main")), before + 1);
  assert.equal(git(root, "log", "-1", "--format=%s"), SUBJECT);
});

// A branch and main changing the same line of a file.
const conflicting = () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "agent/issue-7");
  commitFile(root, "start.txt", "branch\n", "branch edit");
  const tip = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  commitFile(root, "start.txt", "main\n", "main edit");
  return { root, tip, head: git(root, "rev-parse", "HEAD") };
};

for (const mode of ["squash", "merge"] as const) {
  test(`a ${mode} conflict throws, names the file, and abortLanding leaves a clean tree`, () => {
    const { root, tip, head } = conflicting();
    assert.throws(() => mergeBranch(root, "agent/issue-7", tip, "#7", mode));
    assert.equal(git(root, "diff", "--name-only", "--diff-filter=U"), "start.txt");
    abortLanding(root, mode);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "rev-parse", "HEAD"), head);
  });
}

const project = (config: string) => {
  const root = join(TMP, `project${n++}`);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeFileSync(join(root, ".sandcastle", "config.ts"), `export default { name: "demo", gates: [{ name: "t", cmd: "true" }]${config} };\n`);
  return root;
};

test("config: land defaults to merge, accepts squash, refuses anything else", async () => {
  assert.equal((await loadProject(project(""))).land, "merge");
  assert.equal((await loadProject(project(', land: "squash"'))).land, "squash");
  await assert.rejects(loadProject(project(', land: "rebase"')), (e: Error) => e instanceof OperatorError && /land/.test(e.message));
});

// The status view, as in status-queue.test.ts: a fake `sandcastle` listing no queue, a `docker` that finds nothing.
const FAKE = join(TMP, "bin");
mkdirSync(FAKE);
for (const [name, body] of [["sandcastle", "#!/usr/bin/env bash\necho '[]'\n"], ["docker", "#!/bin/sh\nexit 1\n"]]) {
  writeFileSync(join(FAKE, name), body);
  chmodSync(join(FAKE, name), 0o755);
}
// A UTF-8 locale, so widths count characters: Linux runners often have only C.UTF-8.
const utf8 = (() => {
  try {
    return execFileSync("locale", ["-a"], { encoding: "utf8" }).split("\n").find((l) => /^(c|en_US)\.utf-?8$/i.test(l));
  } catch {
    return undefined;
  }
})();
const row7 = (root: string) => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(utf8 ? { LC_ALL: utf8 } : {}),
      PATH: [FAKE, process.env.PATH].join(":"),
      SANDCASTLE_PROJECT: root,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: "120",
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
  });
  const frame = (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, "");
  return frame.split("\n").find((l) => /^│ +#7\b/.test(l));
};
const withLog = (root: string) => {
  mkdirSync(join(root, ".sandcastle", "logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle", "logs", "agent-issue-7-impl-7.log"), "done\n");
};

test("status view: a branch deleted after a squash reads merged, and no branch without the commit", () => {
  const { root, tip } = fixture();
  mergeBranch(root, "agent/issue-7", tip, "#7", "squash");
  git(root, "branch", "-D", "agent/issue-7");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  withLog(root);
  assert.match(row7(root) ?? "", /merged/);
  assert.doesNotMatch(row7(root) ?? "", /no branch/);

  const bare = makeRepo();
  writeFileSync(join(bare, ".gitignore"), ".sandcastle/\n");
  withLog(bare);
  assert.match(row7(bare) ?? "", /no branch/);
});
