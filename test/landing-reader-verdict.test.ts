// The landing reads a green branch through one reader and holds on its verdict: a reader that fails is a hold with
// `reader-failed` that the ledger names, never a landing, and the host reads with object substitution off (#992),
// by the pin on each call and by the process pins `run`, `land` and `gates` set.
// landOne (src/landing.ts) on a temp repo with a fake tracker. No Docker, no gh, no network.
//
//   pnpm test:file test/landing-reader-verdict.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landOne } = await import("../src/landing.ts");
const { disableHostGitHooks, gitFingerprint, pinHostGitConfig } = await import("../src/guard.ts");
const { describe } = await import("../src/ledger.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-reader-verdict-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: root, encoding: "utf8" }).trim();

// main with one file; agent/issue-1 adds `data.txt`, whose blob `lose` deletes from the object store.
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "shared.txt"), "start\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  git(root, "checkout", "-q", "-b", "agent/issue-1");
  writeFileSync(join(root, "data.txt"), "a blob this test loses\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "work on 1");
  git(root, "checkout", "-q", "main");
  return root;
};

const lose = (root: string, rev: string) => {
  const oid = git(root, "rev-parse", rev);
  unlinkSync(join(root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
};

test("a branch whose size cannot be read is held with reader-failed, and the ledger says so", async () => {
  const root = makeRepo();
  // The diff between the trees still reads; only the new blob's size cannot.
  lose(root, "agent/issue-1:data.txt");
  let holds = 0;
  const tracker = { ref: (id: string) => `#${id}`, close: () => assert.fail("a branch that cannot be read must not land"), hold: () => void holds++ };
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: () => {} },
    dryRun: false,
    opener: async () => assert.fail("a held branch opens no sandbox"),
    withdrawal: () => undefined,
    host: createHostGit(project, gitFingerprint(project)),
    gate: async () => ({ gates: [{ name: "test", pass: true }], failures: [] }),
    landed: new Map(),
  };
  const green = { issue: "1", branch: "agent/issue-1", status: "green" as const, commits: 1, repairs: 0, head: git(root, "rev-parse", "agent/issue-1") };
  const before = git(root, "rev-parse", "main");
  const landed = await landOne(ctx, green);
  assert.equal(landed.kind, "held");
  assert.ok(landed.kind === "held");
  assert.equal(landed.code, "reader-failed");
  assert.match(landed.reason, /^human merge: reader-failed: the size of data\.txt/);
  assert.equal(holds, 1);
  const said = describe({ kind: "landing", green, landed, attempts: 1 }, { base: "main", gateNames: "test" });
  assert.match(said.record?.note ?? "", /reader-failed/);
  assert.match(said.tracker?.text ?? "", /could not read what it changes/);
  assert.equal(git(root, "rev-parse", "main"), before, "main did not move");
});

test("the host's own git reads with replace refs off once the process pins are set", () => {
  const root = makeRepo();
  const real = git(root, "rev-parse", "agent/issue-1");
  const benign = git(root, "commit-tree", "main^{tree}", "-p", "main", "-m", "benign");
  git(root, "replace", real, benign);
  const names = () => execFileSync("git", ["diff", "--name-only", `main...${real}`], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(names(), "", "plain git honours the replace ref");
  const saved = { ...process.env };
  try {
    pinHostGitConfig(root);
    assert.equal(names(), "data.txt", "core.useReplaceRefs=false is pinned");
    for (const k of Object.keys(process.env)) if (k.startsWith("GIT_CONFIG_")) delete process.env[k];
    disableHostGitHooks();
    assert.equal(process.env.GIT_NO_REPLACE_OBJECTS, "1");
    assert.equal(names(), "data.txt", "GIT_NO_REPLACE_OBJECTS=1 is set");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
