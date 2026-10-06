// The tip backup's prune (`dropBackup`, src/guard.ts) must leave one pack even where a user's or a
// runner's git config makes a fetch start an auto gc: that gc runs detached and holds `gc.pid`, so
// the prune's own `gc` is refused ("gc is already running"), swallowed, and the dropped work's
// pack stays beside the base's. The kit's git calls on the backup turn background maintenance off.
// Temp repos only: no Docker, no network.
//
//   node --test test/backup-gc.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-backup-gc-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Every pack a fetch leaves counts as too many, so each fetch ends by starting `gc --auto`.
const globalConfig = join(TMP, "gitconfig");
writeFileSync(globalConfig, "[gc]\n\tauto = 1\n\tautoPackLimit = 1\n");
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { backupBranch, backupRepo, dropBackup } = await import("../src/guard.ts");
type Project = import("../src/config.ts").Project;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const project = (root: string) => ({ root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [], mounts: [] }) as unknown as Project;
const packs = (p: Project) => readdirSync(join(backupRepo(p), "objects", "pack")).filter((f) => f.endsWith(".pack")).length;

const files = (root: string, dir: string, count: number) => {
  mkdirSync(join(root, dir), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, dir, `f${i}.txt`), `${dir} ${i}\n`);
  git(root, "add", dir);
};

test("a drop leaves one pack where a fetch would start an auto gc", () => {
  const root = join(TMP, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  files(root, "base", 150);
  git(root, "commit", "-q", "-m", "start");
  const p = project(root);
  for (let id = 1; id <= 3; id++) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    files(root, `work${id}`, 120);
    git(root, "commit", "-q", "-m", `work on ${id}`);
    git(root, "checkout", "-q", "main");
    backupBranch(p, `agent/issue-${id}`);
    dropBackup(p, `agent/issue-${id}`);
    assert.equal(packs(p), 1, `${packs(p)} packs after drop ${id}: the prune was refused`);
  }
});
