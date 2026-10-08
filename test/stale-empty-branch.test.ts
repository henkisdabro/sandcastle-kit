// A ticket branch an earlier run left with no commit ahead of the base (a crashed attempt, or a remainder
// whose work already merged) is cut from the base's tip again before its sandbox opens: Sandcastle checks an
// existing branch out as it stands, so the agent would otherwise work on the tree of the run that left it. A
// branch with commits ahead keeps its fork point and gets the base merged in, in its sandbox. The pipeline
// (`createPipeline`, src/burndown.ts) runs over its faked ports - a temp repo, a host worktree as its
// sandbox, scripted agents and gate runs, and the run's real host git (`createHostGit`) with its `.git`
// check. No Docker, model, gh or network.
//
//   pnpm test:file test/stale-empty-branch.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { createHostGit } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-stale-empty-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
};
const commit = (cwd: string, file: string, text: string, message = `change ${file}`) => {
  write(cwd, file, text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

const ID = "7";
const BRANCH = `agent/issue-${ID}`;
const issue = { id: ID, title: `ticket ${ID}`, body: "" } as Issue;
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/**
 * A project in a temp repo whose `main` has three commits more than the point ticket 7's branch was cut at,
 * and a pipeline over it. `opened` is what the sandbox saw as it opened: the branch's tip and the files the
 * worktree held. `check` is the run's own `.git` check on the fingerprint taken before the attempt.
 */
const harness = (o: { branch?: "empty" | "carried" | "level" | "none"; leftoverWorktree?: boolean } = {}) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "start.txt", "start\n", "start");
  const forkPoint = git(root, "rev-parse", "main");
  const kind = o.branch ?? "empty";
  if (kind === "empty" || kind === "carried") {
    git(root, "branch", BRANCH, "main");
    if (kind === "carried") {
      git(root, "checkout", "-q", BRANCH);
      commit(root, "earlier.txt", "earlier\n", "earlier work");
      git(root, "checkout", "-q", "main");
    }
  }
  // Three landings the earlier run's start never saw.
  for (const f of ["a.txt", "b.txt", "c.txt"]) commit(root, f, `${f}\n`, `landed ${f}`);
  if (kind === "level") git(root, "branch", BRANCH, "main");
  const oldTip = kind === "none" ? undefined : git(root, "rev-parse", BRANCH);

  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((name) => {
      const file = join(root, `.sandcastle/.run/${name}.md`);
      write(root, `.sandcastle/.run/${name}.md`, "{{ISSUE_NUMBER}} {{REVIEW_BASE}} {{REPAIR_BASE}}\n");
      return [name, file];
    }),
  ) as Ctx["prompts"];
  const events: string[] = [];
  const opened: { tip?: string; files: string[] }[] = [];

  const leftover = join(TMP, `leftover${n++}`);
  if (o.leftoverWorktree) git(root, "worktree", "add", "-q", leftover, BRANCH);

  const open = async (branch: string): Promise<Box> => {
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    // As Sandcastle does: a worktree already on the branch is reused, the branch otherwise checked out as it stands.
    const reused = git(root, "worktree", "list", "--porcelain").includes(`branch refs/heads/${branch}`);
    const path = reused ? leftover : join(TMP, `wt${n++}`);
    if (!reused) {
      if (exists) git(root, "worktree", "add", "-q", path, branch);
      else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    }
    opened.push({ tip: exists ? git(root, "rev-parse", `refs/heads/${branch}`) : undefined, files: ["a.txt", "b.txt", "c.txt", "earlier.txt"].filter((f) => existsSync(join(path, f))) });
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const name = (opts.name ?? "").split("-")[0];
        events.push(name);
        const before = git(path, "rev-parse", "HEAD");
        if (name === "impl") commit(path, "seven.txt", "seven\n");
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };

  const project = {
    root,
    name: "fixture",
    baseBranch: "main",
    gates: [{ name: "test", command: "run-tests" }],
    generated: [],
    setup: [],
    implement: {},
    review: {},
    repair: {},
  } as unknown as Ctx["project"];
  // Taken at the run's start, with the branch where the earlier run left it.
  const host = createHostGit(project, gitFingerprint(project));

  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-08T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      events.push("gate");
      return GREEN;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, _phase, fn) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host,
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });

  const attempt = async () => {
    const { result, lines } = await quietly(() => pipeline(issue));
    return { o: result, lines };
  };
  return { root, forkPoint, oldTip, opened, events, host, attempt };
};

test("a branch with no commits ahead of the base is at the base's tip when its sandbox opens", async () => {
  const h = harness({ branch: "empty" });
  assert.equal(h.oldTip, h.forkPoint, "the fixture's branch starts at the old fork point");
  const mainTip = git(h.root, "rev-parse", "main");
  const { o, lines } = await h.attempt();
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].tip, mainTip);
  assert.deepEqual(h.opened[0].files, ["a.txt", "b.txt", "c.txt"], "the agent's tree holds the three landings it is behind");
  assert.ok(lines.includes(`#7: ${BRANCH} had no commits ahead of main and was 3 commit(s) behind it - cut again from main's tip.`), lines.join("\n"));
  // The agent's work sits on the base's tip, so nothing of the earlier run's fork point is left in it.
  assert.equal(o.status, "green");
  assert.equal(o.commits, 1);
  assert.equal(git(h.root, "rev-parse", `${BRANCH}~1`), mainTip);
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
});

test("the run's .git check takes the moved branch: it was cut by the run, so nothing else touched it", async () => {
  const h = harness({ branch: "empty" });
  await h.attempt();
  await h.host.check("after the ticket");
  assert.equal(h.host.expected.branches[BRANCH], git(h.root, "rev-parse", BRANCH));
  assert.equal(h.host.failed, undefined);
});

test("a branch with commits ahead keeps its fork point: the sandbox opens on it and merges the base in", async () => {
  const h = harness({ branch: "carried" });
  const { lines } = await h.attempt();
  assert.equal(h.opened[0].tip, h.oldTip, "the branch is not moved");
  assert.deepEqual(h.opened[0].files, ["earlier.txt"]);
  assert.ok(!lines.some((l) => l.includes("cut again")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("#7: merged main (3 commit(s)) into its branch")), lines.join("\n"));
  // Its earlier commit is still on the branch, with the base merged in beside it.
  git(h.root, "merge-base", "--is-ancestor", h.oldTip!, BRANCH);
  git(h.root, "merge-base", "--is-ancestor", "main", BRANCH);
});

test("a branch level with the base, and a ticket with no branch, are not touched", async () => {
  for (const branch of ["level", "none"] as const) {
    const h = harness({ branch });
    const { lines } = await h.attempt();
    assert.ok(!lines.some((l) => l.includes("cut again")), `${branch}: ${lines.join("\n")}`);
    assert.equal(h.opened[0].tip, h.oldTip, branch);
    assert.deepEqual(h.opened[0].files, ["a.txt", "b.txt", "c.txt"], branch);
  }
});

test("a branch still checked out in a worktree is not moved from under it: the attempt goes on as before", async () => {
  const h = harness({ branch: "empty", leftoverWorktree: true });
  const { o, lines } = await h.attempt();
  assert.equal(h.opened[0].tip, h.oldTip, "git refuses to move a branch a worktree holds, and the run does not force it");
  assert.ok(lines.some((l) => l.startsWith(`#7: ${BRANCH} had no commits ahead of main and was 3 commit(s) behind it, but could not be cut again from main's tip (`)), lines.join("\n"));
  assert.equal(o.status, "green");
});
