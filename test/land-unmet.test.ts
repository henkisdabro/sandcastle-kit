// `sandcastle land <ticket>` lands a branch the way a run does: one whose agents left an acceptance
// criterion unmet (recorded in logs/heads.json, and as `unmet` on the run record's ticket) is merged
// as "part of" its ticket and the ticket stays open with the criterion commented; one without lands
// and closes. A temp git repo, the ticket-file tracker and a host worktree for the sandbox.
//
//   node --test test/land-unmet.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@localhost" });
const { landTicket } = await import("../src/land.ts");
const { recordHead } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;
type Opener = import("../src/land.ts").Opener;

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-land-unmet-"));
const ID = "demo-01";
const BRANCH = `agent/issue-${ID}`;
const CRITERION = "the --json flag is not wired up";
let n = 0;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
};
const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

// `record`: what the run left behind for the branch - the heads record, the run record, or neither.
const fixture = (record: { heads?: "at-head" | "moved" | "no-unmet"; run?: boolean } = {}) => {
  const root = join(tmp, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, ".gitignore", ".sandcastle/\n");
  write(root, ".scratch/demo/issues/01-thing.md", "# A thing\n\nStatus: ready-for-agent\n\nDo it.\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", BRANCH);
  write(root, "feature.txt", "the feature\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "branch");
  const head = git(root, "rev-parse", "HEAD").out;
  git(root, "checkout", "-q", "main");
  if (record.heads) {
    const green = record.heads === "moved" ? "0".repeat(40) : head;
    recordHead(root, ID, { branch: BRANCH, green, ...(record.heads === "no-unmet" ? {} : { unmet: CRITERION }) }, "2026-10-01T00:00:00.000Z");
  }
  if (record.run) write(root, ".sandcastle/logs/run.json", JSON.stringify({ tickets: { [ID]: { state: "held", unmet: CRITERION } } }));
  const project = {
    name: "demo",
    root,
    baseBranch: "main",
    tracker: fakeTracker({ kind: "files" }),
    label: "ready-for-agent",
    gates: [{ name: "check", command: "test -f feature.txt" }],
    setup: [],
    generated: [],
  } as unknown as Project;
  const open: Opener = async (branch) => {
    const path = join(tmp, `wt-${n++}`);
    assert.equal(git(root, "worktree", "add", "-q", "-b", branch, path, "main").status, 0);
    return {
      worktreePath: path,
      // execGate wraps commands in `timeout -k n n`, which macOS lacks.
      exec: async (cmd) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => git(root, "worktree", "remove", "--force", path),
    };
  };
  const land = async () => {
    const log = mock.method(console, "log", () => {});
    try {
      return await landTicket(project, makeTracker(project), ID, () => ({ open }));
    } finally {
      log.mock.restore();
    }
  };
  const ticketFile = () => readFileSync(join(root, ".scratch/demo/issues/01-thing.md"), "utf8");
  // The merge is the commit before any the files tracker adds on top (a comment is a commit too).
  const mergeSubjects = () => git(root, "log", "--merges", "--format=%s", "main").out;
  return { root, land, ticketFile, mergeSubjects };
};

test("a branch with an unmet criterion in heads.json lands as part of its ticket, which stays open", async () => {
  const f = fixture({ heads: "at-head" });
  const said = await f.land();
  assert.match(said, /^Landed demo-01 as partly done: merged agent\/issue-demo-01 into main and left it open/);
  assert.ok(said.includes(CRITERION), said);
  assert.equal(f.mergeSubjects(), `Merge ${BRANCH} (part of ${ID})`);
  const text = f.ticketFile();
  assert.match(text, /^Status: ready-for-agent$/m);
  assert.ok(text.includes(`**Left open: an acceptance criterion is unmet.** ${CRITERION}`), text);
  assert.ok(text.includes("by `sandcastle land` from `agent/issue-demo-01`"), text);
  assert.equal(git(f.root, "branch", "--list", BRANCH).out, "");
});

test("a held branch with only the run record's criterion lands as partly done too", async () => {
  const f = fixture({ run: true });
  const said = await f.land();
  assert.match(said, /as partly done/);
  assert.equal(f.mergeSubjects(), `Merge ${BRANCH} (part of ${ID})`);
  assert.match(f.ticketFile(), /^Status: ready-for-agent$/m);
  assert.ok(f.ticketFile().includes(CRITERION));
});

test("a branch with no recorded criterion lands and closes, as before", async () => {
  for (const f of [fixture(), fixture({ heads: "no-unmet" })]) {
    const said = await f.land();
    assert.match(said, /^Landed demo-01: merged agent\/issue-demo-01 into main and closed it\./);
    assert.equal(f.mergeSubjects(), `Merge ${BRANCH} (closes ${ID})`);
    assert.match(f.ticketFile(), /^Status: done$/m);
    assert.ok(!f.ticketFile().includes("unmet"));
  }
});

test("a green record the branch has moved on from is not applied", async () => {
  // A person worked on the branch after the run: the run's judgement of the old head does not carry over.
  const f = fixture({ heads: "moved", run: true });
  const said = await f.land();
  assert.match(said, /and closed it\./);
  assert.equal(f.mergeSubjects(), `Merge ${BRANCH} (closes ${ID})`);
  assert.match(f.ticketFile(), /^Status: done$/m);
});
