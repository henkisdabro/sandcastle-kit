// In-run landing beside live sandboxes (src/landing.ts, src/land.ts, src/guard.ts): the writer
// adopts only the base movement its own write made, an unexpected error costs one ticket, a
// sandbox landing's scratch ref cannot be swapped, HEAD is fingerprinted, a waiting landing gets
// the next sandbox slot, and the git config keys that run a program are pinned. Temp repos, a
// fake tracker and host worktrees for the sandbox: no Docker, no gh, no network.
//
//   pnpm exec tsx --test test/landing-hardening.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR|CONFIG)_?/.test(k)) delete process.env[k];
const { createHostGit, createLanding, landingMade, slotTurn, trackerMade } = await import("../src/landing.ts");
const { assertGitUnchanged, gitFingerprint, pinHostGitConfig } = await import("../src/guard.ts");
const { landInSandbox, plainMergeNote } = await import("../src/land.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Landed = import("../src/landing.ts").Landed;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-hardening-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
const makeRepo = (branches: Record<string, Record<string, string>> = {}) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "gc.auto", "0");
  commitFile(root, "shared.txt", "start\n", "start");
  for (const [id, files] of Object.entries(branches)) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    for (const [file, text] of Object.entries(files)) commitFile(root, file, text, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  return root;
};
const project = (root: string) => ({ root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] }) as unknown as Project;

// A commit made the way another process could: straight into the object store, then `main` moved
// to it, with the working tree left alone. `parents` and the file it writes are the caller's.
const forge = (root: string, parents: string[], file: string, text: string) => {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: text, encoding: "utf8" }).trim();
  const index = join(TMP, `index${n++}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["read-tree", parents[0]], { cwd: root, env });
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { cwd: root, env });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" }).trim();
  return git(root, "commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "planted");
};

const opener = (root: string): Ctx["opener"] => async (branch) => {
  const path = join(TMP, `wt${n++}`);
  git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  return {
    worktreePath: path,
    exec: async (cmd) => {
      const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    close: async () => git(root, "worktree", "remove", "--force", path),
  };
};
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

test("the base moved by another process during a write that commits nothing stops the run", async () => {
  const root = makeRepo();
  const host = createHostGit(project(root), gitFingerprint(project(root)));
  const prev = host.expected.base;
  // As during a `gh issue close`, which takes seconds: a sandbox moves main.
  await assert.rejects(
    host.write(() => git(root, "update-ref", "refs/heads/main", forge(root, [prev], "evil.txt", "x\n")), trackerMade(root)),
    /main moved to .* while the kit wrote to it, and not by that write/,
  );
  assert.equal(host.expected.base, prev, "the planted commit was adopted as the kit's own");
  assert.ok(host.failed);
  await assert.rejects(host.check("after #2"), /STOPPED after #2: main moved/);
});

test("without a check of its own, a write must leave the base where it was", async () => {
  const root = makeRepo();
  const host = createHostGit(project(root), gitFingerprint(project(root)));
  await assert.rejects(host.write(() => git(root, "commit", "-q", "--allow-empty", "-m", "anything")), /this write commits nothing/);
});

test("a files-tracker commit of the file the host wrote is accepted; a forged one is not", async () => {
  const root = makeRepo();
  const host = createHostGit(project(root), gitFingerprint(project(root)));
  await host.write(() => commitFile(root, "tickets/01.md", "Status: done\n", "sandcastle: close 01"), trackerMade(root));
  assert.equal(host.expected.base, git(root, "rev-parse", "main"));
  // One file, one commit on the tip - but not what the host wrote to it.
  const prev = host.expected.base;
  await assert.rejects(
    host.write(() => git(root, "update-ref", "refs/heads/main", forge(root, [prev], "tickets/01.md", "Status: ready-for-agent\n")), trackerMade(root)),
    /commits a tickets\/01\.md that is not the one the host wrote/,
  );
});

test("a landing write is accepted only as a merge holding the gated head's tree", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  const head = git(root, "rev-parse", "agent/issue-1");
  const real = createHostGit(project(root), gitFingerprint(project(root)));
  await real.write(() => git(root, "merge", "-q", "--no-ff", "-m", "Merge agent/issue-1 (closes #1)", head), landingMade(root, head, "merge"));
  assert.equal(real.expected.base, git(root, "rev-parse", "main"));

  const root2 = makeRepo({ 1: { "a.txt": "a\n" } });
  const head2 = git(root2, "rev-parse", "agent/issue-1");
  const host = createHostGit(project(root2), gitFingerprint(project(root2)));
  const prev = host.expected.base;
  // The right parents, other content in the branch's own file.
  const planted = forge(root2, [prev, head2], "a.txt", "evil\n");
  await assert.rejects(
    host.write(() => git(root2, "update-ref", "refs/heads/main", planted), landingMade(root2, head2, "merge")),
    /does not hold the gated tree/,
  );
  assert.equal(host.expected.base, prev);
});

test("an unexpected error while landing costs that ticket only, and the others still land", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const p = project(root);
  const host = createHostGit(p, gitFingerprint(p));
  const states: Record<string, string | undefined> = {};
  const ctx: Ctx = {
    project: p,
    tracker: { ref: (id: string) => `#${id}`, close: () => {}, comment: () => {}, hold: () => {} } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: {
      ticket: (id, fields) => {
        // A full disk, a gh error: anything that is not an OperatorError.
        if (id === "1" && fields.state === "landing") throw new Error("ENOSPC: no space left on device");
        if (typeof fields.state === "string") states[id] = fields.state;
      },
    },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host,
    gate: async () => GREEN,
    landed: new Map(),
  };
  const settled: { issue: string; landed: Landed }[] = [];
  const landing = createLanding(ctx, { settled: (o, landed) => void settled.push({ issue: o.issue, landed }), stopped: () => {} });
  for (const id of ["1", "2"]) {
    landing.push({ issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${id}`) });
  }
  landing.close();
  await landing.run();
  assert.deepEqual(
    settled.map((s) => [s.issue, s.landed.kind]),
    [
      ["1", "not-landed"],
      ["2", "merged"],
    ],
  );
  assert.match(JSON.stringify(settled[0].landed), /ENOSPC/);
  assert.equal(landing.stop, undefined);
  assert.equal(states["2"], "merged");
});

test("a scratch ref repointed while the merge is gated lands nothing", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  commitFile(root, "other.txt", "moved on\n", "base moved");
  const head = git(root, "rev-parse", "agent/issue-1");
  const base = git(root, "rev-parse", "main");
  let scratch = "";
  const open = opener(root);
  const result = await landInSandbox(
    project(root),
    { branch: "agent/issue-1", head, message: "Merge agent/issue-1 (closes #1)" },
    async (branch) => {
      scratch = branch;
      return open(branch);
    },
    // Another live sandbox, while the gates run: the same parents, other content in the branch's file.
    async () => {
      git(root, "update-ref", `refs/heads/${scratch}`, forge(root, [base, head], "a.txt", "evil\n"));
      return GREEN;
    },
  );
  assert.equal(result.kind, "conflict");
  assert.match((result as { note?: string }).note ?? "", /ref moved after the merge/);
  assert.equal(git(root, "rev-parse", "main"), base, "the swapped merge landed");
});

test("a merge with the right parents but not the host's own merge tree is refused", () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  commitFile(root, "other.txt", "moved on\n", "base moved");
  const head = git(root, "rev-parse", "agent/issue-1");
  const base = git(root, "rev-parse", "main");
  git(root, "merge", "-q", "--no-ff", "-m", "real", head);
  const real = git(root, "rev-parse", "HEAD");
  // On git without `merge-tree --write-tree` the check steps aside; the path check still runs.
  const supported = spawnSync("git", ["merge-tree", "--write-tree", base, head], { cwd: root }).status === 0;
  assert.equal(plainMergeNote(root, real, base, head), undefined);
  const planted = forge(root, [base, head], "a.txt", "evil\n");
  assert.equal(plainMergeNote(root, planted, base, head), supported ? "landing merge does not hold the tree the host's own merge makes" : undefined);
});

test("HEAD repointed by a sandbox is tampering, and info/refs rewritten by a repack is not", () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  const p = project(root);
  const before = gitFingerprint(p);
  git(root, "update-server-info");
  assert.doesNotThrow(() => assertGitUnchanged(p, before, "after #1"));
  // The base does not move, so only HEAD's own fingerprint can catch it.
  git(root, "symbolic-ref", "HEAD", "refs/heads/agent/issue-1");
  assert.throws(() => assertGitUnchanged(p, before, "after #1"), /STOPPED after #1: .*HEAD changed/);
});

test("pipelines wait for their slot while a landing wants one", async () => {
  const wanted = { n: 1 };
  let started = false;
  const pipeline = slotTurn(wanted, 5).then(() => (started = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(started, false, "a pipeline took the slot a landing waited for");
  wanted.n = 0;
  await pipeline;
  assert.equal(started, true);
});

test("config keys that run a program are pinned for the host's git: signing off, drivers as at the start", () => {
  const root = makeRepo();
  const marker = join(TMP, `ran-${n++}`);
  git(root, "config", "filter.lfsish.smudge", "cat");
  git(root, "config", "commit.gpgSign", "true");
  pinHostGitConfig(root);
  // Planted after the start, as a sandbox could between a check and a host git call.
  git(root, "config", "core.fsmonitor", `touch ${marker}; true`);
  git(root, "config", "filter.lfsish.smudge", `touch ${marker}; cat`);
  git(root, "config", "gpg.program", `touch ${marker}; false`);
  assert.equal(git(root, "config", "--get", "core.fsmonitor"), "false");
  assert.equal(git(root, "config", "--get", "filter.lfsish.smudge"), "cat");
  assert.equal(git(root, "config", "--get", "commit.gpgsign"), "false");
  writeFileSync(join(root, ".gitattributes"), "*.txt filter=lfsish\n");
  commitFile(root, "x.txt", "x\n", "a commit and a status, as landing makes");
  git(root, "status", "--porcelain");
  assert.equal(existsSync(marker), false, "a planted command ran");
  // A second turn reads a config sandboxes have touched: the first value stays.
  pinHostGitConfig(root);
  assert.equal(git(root, "config", "--get", "filter.lfsish.smudge"), "cat");
});
