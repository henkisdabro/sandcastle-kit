// The end-of-run verify is due after one merged ticket as after several: a run that lands exactly one ticket as a
// fast-forward leaves a `ticket-sandbox` record, which proves nothing in a clean gate-only sandbox, so the verify
// runs; one landing merged in a landing sandbox leaves a gate-only proof and the verify is skipped. Temp repos, a host
// worktree for the landing sandbox, a fake docker - no Docker, no model, no network.
//
//   pnpm test:file test/verify-after-one-merge.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-verify-one-merge-")));
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.XDG_CONFIG_HOME = join(dir, "config");
const bin = join(dir, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh
case "$*" in
  *"sh -c git rev-parse HEAD") git -C "$SANDCASTLE_TEST_REPO" rev-parse main ;;
esac
exit 0
`,
);
chmodSync(join(bin, "docker"), 0o755);
process.env.PATH = [bin, dirname(process.execPath), process.env.PATH].join(delimiter);
mkdirSync(join(dir, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(dir, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { greenProofOfBase, noteGreenCommit, verifyPlan } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");
const { landOne, createHostGit } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { inject } = await import("../src/pool.ts");
const { commandOf } = await import("../src/live-runs.ts");
// This process takes slots, as a run would: `ps` would call it a test runner, and its slot stale.
inject({ probe: (pid) => (pid === process.pid ? everyPidIsTheKit() : commandOf(pid)) });
type Ctx = import("../src/landing.ts").LandContext;
type Opener = import("../src/land.ts").Opener;

const IMAGE = "sandcastle-fixture:t";
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

let n = 0;
/** main with `agent/issue-7` forked from it; with `moved` the base moves on after the fork, so landing 7 is a merge, not a fast-forward. */
const makeProject = (moved: boolean) => {
  const root = join(dir, `project${n++}`);
  process.env.SANDCASTLE_TEST_REPO = root;
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "check-red" }] };\n`);
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "init");
  git(root, "checkout", "-q", "-b", "agent/issue-7", "main");
  writeFileSync(join(root, "seven.txt"), "7\n");
  git(root, "add", "seven.txt");
  git(root, "commit", "-q", "-m", "work on 7");
  git(root, "checkout", "-q", "main");
  if (moved) {
    writeFileSync(join(root, "three.txt"), "3\n");
    git(root, "add", "three.txt");
    git(root, "commit", "-q", "-m", "ticket 3 landed");
  }
  return root;
};

/** Lands ticket 7 as `burndown()` wires it - the landing says whose gates ran and where - and returns the record's proof of the new tip. */
const landSeven = async (root: string) => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    const plan = writePlan(project).file;
    const open: Opener = async (name) => {
      const path = join(dir, `wt${n++}`);
      git(root, "worktree", "add", "-q", "-b", name, path, "main");
      return {
        worktreePath: path,
        exec: async (cmd) => {
          const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
          return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
        },
        close: async () => git(root, "worktree", "remove", "--force", path),
      };
    };
    const ctx: Ctx = {
      project,
      tracker: { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
      base: "main",
      gateNames: "test",
      reports: new Map(),
      run: { ticket: () => {} },
      dryRun: false,
      opener: open,
      withdrawal: () => undefined,
      host: createHostGit(project, gitFingerprint(project)),
      gate: async () => ({ gates: [], failures: [] }),
      greenBase: (commit, by, kind) => noteGreenCommit(project, IMAGE, plan, commit, by, kind),
      landed: new Map(),
    };
    const head = git(root, "rev-parse", "agent/issue-7");
    const landed = await quietly(() => landOne(ctx, { issue: "7", branch: "agent/issue-7", status: "green", commits: 1, repairs: 0, head }));
    assert.equal(landed.result.kind, "merged");
    return { project, plan, tip: git(root, "rev-parse", "main"), proof: greenProofOfBase(project, IMAGE, plan) };
  } finally {
    process.chdir(cwd);
  }
};

test("one ticket landed as a fast-forward still gets the end-of-run verify", async () => {
  const root = makeProject(false);
  const { project, plan, tip } = await landSeven(root);
  const record = JSON.parse(readFileSync(join(root, ".sandcastle/.run/base-gates.json"), "utf8"));
  assert.deepEqual([record.commit, record.by, record.kind], [tip, "#7", "ticket-sandbox"]);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    assert.deepEqual(verifyPlan(project, IMAGE, plan, 1, 0), { due: true });
  } finally {
    process.chdir(cwd);
  }
});

test("one ticket merged in a landing sandbox does not get a second verify", async () => {
  const root = makeProject(true);
  const { project, plan, tip } = await landSeven(root);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    assert.deepEqual(verifyPlan(project, IMAGE, plan, 1, 0), { due: true, skipped: { commit: tip, by: "#7", kind: "landing-sandbox" } });
  } finally {
    process.chdir(cwd);
  }
});

test("a record with no kind (an older kit's) leaves the verify to run after one merge", async () => {
  const root = makeProject(true);
  const { project, plan } = await landSeven(root);
  const record = join(root, ".sandcastle/.run/base-gates.json");
  const { kind: _k, ...old } = JSON.parse(readFileSync(record, "utf8"));
  writeFileSync(record, JSON.stringify(old) + "\n");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    assert.deepEqual(verifyPlan(project, IMAGE, plan, 1, 0), { due: true });
  } finally {
    process.chdir(cwd);
  }
});

test("a run that merged nothing has no verify", async () => {
  const root = makeProject(false);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    assert.deepEqual(verifyPlan(project, IMAGE, writePlan(project).file, 0, 0), { due: false });
  } finally {
    process.chdir(cwd);
  }
});

test("burndown asks verifyPlan for the verify, with no merged-count guard of its own", () => {
  const burndown = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(burndown, /const verifyDue = verifyPlan\(gateProject, image, planFile, merged\.length, regenerated\);\n\s*if \(verifyDue\.due\) \{/);
  assert.doesNotMatch(burndown, /merged\.length > 1/);
});
