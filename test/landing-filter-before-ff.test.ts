// A filter planted in the shared `.git` after a landing sandbox closed (src/land.ts): the `.git`
// check that follows the sandbox is followed by host git calls, and the fast-forward writes files
// out through smudge filters, so another ticket's sandbox - still running against the same `.git` -
// could plant `filter.<x>.smudge` and `info/attributes` in between and have it run on the host.
// A `git` shim on PATH plants it on the first host call after that check, which no gate or sandbox
// callback can reach (they run before it). Temp repos and host worktrees: no Docker, no network.
//
//   pnpm test:file test/landing-filter-before-ff.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { gitFingerprint } = await import("../src/guard.ts");
const { landInSandbox } = await import("../src/land.ts");
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-filter-before-ff-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
// `main` has moved on since agent/issue-1 forked from it, so the landing is a real merge.
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  commitFile(root, "shared.txt", "start\n", "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  commitFile(root, "a.txt", "a\n", "work on 1");
  git(root, "checkout", "-q", "main");
  commitFile(root, "other.txt", "moved on\n", "base moved");
  return root;
};
const project = (root: string, land: "merge" | "squash") => ({ root, name: "fixture", baseBranch: "main", land, generated: [], gates: [], setup: [] }) as unknown as Project;

const opener = (root: string) => async (branch: string) => {
  const path = join(TMP, `wt${n++}`);
  git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  return {
    worktreePath: path,
    exec: async (cmd: string) => {
      const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    close: async () => git(root, "worktree", "remove", "--force", path),
  };
};
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/**
 * A `git` that, on the first call run from `root` itself (the host's; a sandbox's runs in its own worktree)
 * whose arguments include `trigger`, plants what another ticket's sandbox could: a smudge filter that touches
 * `marker`, and the attribute that applies it to every file. Then it runs the real git.
 */
const plantingGit = (root: string, trigger: string, marker: string) => {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const dir = join(TMP, `shim${n++}`);
  mkdirSync(dir);
  const done = join(dir, "planted");
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    join(dir, "git"),
    [
      "#!/bin/sh",
      `if [ "$(pwd -P)" = ${sq(root)} ] && [ ! -e ${sq(done)} ]; then`,
      `  case " $* " in *" ${trigger} "*)`,
      `    : > ${sq(done)}`,
      `    ${sq(real)} config filter.evil.smudge ${sq(`touch ${marker}; cat`)}`,
      `    printf '* filter=evil\\n' >> ${sq(join(root, ".git", "info", "attributes"))}`,
      "    ;; esac",
      "fi",
      `exec ${sq(real)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "git"), 0o755);
  return { dir, planted: () => existsSync(done) };
};

// What a run passes (its fingerprint, which moves the base with the kit's own writes) and what `sandcastle land` passes (none).
const cases = [
  { name: "a merge landing in a run", land: "merge" as const, trigger: "rev-list", run: true },
  { name: "a squash landing in a run", land: "squash" as const, trigger: "commit-tree", run: true },
  { name: "a merge landed by `sandcastle land`", land: "merge" as const, trigger: "rev-list", run: false },
];

for (const c of cases) {
  test(`${c.name} stops before the fast-forward when a filter was planted since the sandbox closed`, async () => {
    const root = makeRepo();
    const p = project(root, c.land);
    const head = git(root, "rev-parse", "agent/issue-1");
    const base = git(root, "rev-parse", "main");
    const marker = join(TMP, `ran-${n++}`);
    const shim = plantingGit(root, c.trigger, marker);
    const path = process.env.PATH;
    process.env.PATH = `${shim.dir}${delimiter}${path}`;
    try {
      await assert.rejects(
        landInSandbox(p, { branch: "agent/issue-1", head, message: "Merge agent/issue-1 (closes #1)", squash: c.land === "squash" }, opener(root), async () => GREEN, c.run ? gitFingerprint(p) : undefined),
        /STOPPED before fast-forwarding agent\/issue-1: .*(config|info\/attributes).* changed while sandboxes ran/s,
      );
    } finally {
      process.env.PATH = path;
    }
    assert.ok(shim.planted(), "the shim never planted: the test did not reach the window it is about");
    assert.match(readFileSync(join(root, ".git", "config"), "utf8"), /smudge/, "the filter was not in the shared .git");
    assert.equal(existsSync(marker), false, "the planted filter ran on the host");
    assert.equal(git(root, "rev-parse", "main"), base, "the base was fast-forwarded past the check");
    assert.equal(existsSync(join(root, "a.txt")), false, "the branch's file was checked out");
  });
}

test("a landing with nothing planted still fast-forwards, so the check before the fast-forward is no false stop", async () => {
  const root = makeRepo();
  const p = project(root, "merge");
  const head = git(root, "rev-parse", "agent/issue-1");
  const result = await landInSandbox(p, { branch: "agent/issue-1", head, message: "Merge agent/issue-1 (closes #1)" }, opener(root), async () => GREEN, gitFingerprint(p));
  assert.equal(result.kind, "merged");
  assert.equal(git(root, "rev-parse", "main"), (result as { commit: string }).commit);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
});
