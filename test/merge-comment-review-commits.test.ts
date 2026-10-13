// When a review reworks a branch, the ticket's merge comment lists the review's commits (short hash and
// subject), so a reader of the implementer's record sees that the branch changed after it. The pipeline
// (`createPipeline`, src/burndown.ts) runs over a temp repo with a scripted agent, and the ledger
// (`describe`, src/ledger.ts) words the comment. No Docker, model, gh or network.
//
//   pnpm test:file test/merge-comment-review-commits.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merges pass process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { describe } = await import("../src/ledger.ts");
const { renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-merge-comment-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};

const ID = "7";
const ISSUE = { id: ID, title: "seven", body: "" } as Parameters<ReturnType<typeof createPipeline>>[0];
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/** A project in a temp repo whose prompts are the kit's own, and a pipeline over it with every port faked. */
const harness = (opts: { changelog: boolean; land?: "squash" } = { changelog: true }) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n");

  const project = {
    root, name: "fixture", label: "ready-for-agent", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }],
    generated: [], setup: [], implement: {}, review: {}, repair: {}, tracker: fakeTracker(), changelog: opts.changelog, ...(opts.land ? { land: opts.land } : {}),
  };
  const prompts = renderPrompts(project as unknown as Parameters<typeof renderPrompts>[0], makeTracker(project as unknown as Parameters<typeof makeTracker>[0]));

  const passes: { name: string; promptFile: string; args: Record<string, string> }[] = [];
  const agents: Record<string, (worktree: string) => string> = {};
  const gates: GateRun[] = [];
  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (o: { name?: string; promptFile?: string; promptArgs?: Record<string, string> }) => {
        const name = o.name ?? "";
        passes.push({ name, promptFile: o.promptFile ?? "", args: o.promptArgs ?? {} });
        const before = git(path, "rev-parse", "HEAD");
        const stdout = agents[name.split("-")[0]]?.(path) ?? "";
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout, commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };
  const pipeline = createPipeline({
    project: project as unknown as Ctx["project"],
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-05T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      const next = gates.shift();
      assert.ok(next, "a gate run the test did not expect");
      return next;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, _phase, fn) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });
  const attempt = async () => (await quietly(() => pipeline(ISSUE))).result;
  return { prompts, passes, agents, gates, attempt };
};

/** An implementer that commits a file. */
const implementing = (wt: string) => {
  commit(wt, "a.txt", "a\n");
  return "";
};

const landed = (outcome: { reviewLog?: string[] }) =>
  describe(
    { kind: "landing", green: { issue: ID, branch: `agent/issue-${ID}`, status: "green", commits: 2, repairs: 0, ...outcome }, landed: { kind: "merged" }, attempts: 1 },
    { base: "main", gateNames: "test" },
  ).tracker!.text;

test("the merge comment lists a review's commit by short hash and subject", async () => {
  const h = harness();
  h.agents.impl = implementing;
  h.agents.review = (wt) => {
    commit(wt, "b.txt", "b\n");
    git(wt, "commit", "-q", "--amend", "-m", "refactor: drop the cache the record described");
    return "";
  };
  h.gates.push(GREEN);
  const outcome = await h.attempt();
  assert.equal(outcome.reviewCommits, 1);
  assert.equal(outcome.reviewLog?.length, 1);
  assert.match(outcome.reviewLog![0], /^[0-9a-f]{7,} refactor: drop the cache the record described$/);
  const text = landed(outcome);
  assert.match(text, /^Merged locally, not yet pushed, by the Sandcastle loop from `agent\/issue-7`/);
  assert.ok(text.includes(`\n\nThe review changed the branch (1 commit(s)):\n- ${outcome.reviewLog![0]}`), text);
});

test("the merge comment is as before when the review committed nothing", async () => {
  const h = harness();
  h.agents.impl = implementing;
  h.gates.push(GREEN);
  const outcome = await h.attempt();
  assert.equal(outcome.reviewCommits, 0);
  assert.equal(outcome.reviewLog, undefined);
  assert.doesNotMatch(landed(outcome), /review changed/);
});

test("the merge comment names each review commit, oldest first, and leaves the implementer's out", async () => {
  const h = harness();
  h.agents.impl = implementing;
  h.agents.review = (wt) => {
    commit(wt, "b.txt", "b\n");
    commit(wt, "c.txt", "c\n");
    return "";
  };
  h.gates.push(GREEN);
  const outcome = await h.attempt();
  assert.deepEqual(outcome.reviewLog?.map((l) => l.replace(/^\w+ /, "")), ["change b.txt", "change c.txt"]);
  assert.doesNotMatch(landed(outcome), /change a\.txt/);
  assert.match(landed(outcome), /\(2 commit\(s\)\):\n- \w+ change b\.txt\n- \w+ change c\.txt/);
});

test("a project that lands by squash gets the review's subjects alone: the branch and its hashes are gone after landing", async () => {
  const h = harness({ changelog: true, land: "squash" });
  h.agents.impl = implementing;
  h.agents.review = (wt) => {
    commit(wt, "b.txt", "b\n");
    return "";
  };
  h.gates.push(GREEN);
  const outcome = await h.attempt();
  assert.deepEqual(outcome.reviewLog, ["change b.txt"]);
});
