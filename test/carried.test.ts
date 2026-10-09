// A carried branch that was implemented and reviewed, then stopped while its gates ran, has no gate result
// and is not red: a re-run goes straight to the gates (after a narrow review of a base merge that no review
// has read), where it used to get a whole implement session whose agent said the work was already there.
// Only a red gate result, or commits after the review, sends it back to the implementer. The pipeline
// (`createPipeline`, src/burndown.ts) runs over a temp repo with scripted agents and gate runs. No Docker,
// model, gh or network.
//
//   pnpm test:file test/carried.test.ts

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
const { readHeads } = await import("../src/run.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type GateRun = import("../src/gates.ts").GateRun;
type RedLanding = import("../src/landing.ts").RedLanding;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-pipeline-"));
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
const ISSUE = { id: ID, title: "seven", body: "" } as Parameters<ReturnType<typeof createPipeline>>[0];

const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const red = (output: string): GateRun => {
  const failure = { name: "test", command: "run-tests", exitCode: 1, output };
  return { gates: [{ name: "test", pass: false }], failure, failures: [failure] };
};

/** What an agent does in the sandbox's worktree, by its pass: `impl`, `review`, `repair` or `resolve`. Returns its final message. */
type Agent = (worktree: string) => string | void;

/**
 * A project in a temp repo and a pipeline over it, with every port faked. `events` is each agent pass
 * and gate run in order; `passes` the passes' names and prompt arguments; `phases` each timed step.
 */
const harness = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n", "start");
  // Each prompt names every argument its pass may get, so `usedArgs` passes them all on.
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const events: string[] = [];
  const passes: { name: string; args: Record<string, string> }[] = [];
  const phases: string[] = [];
  const agents: Record<string, Agent> = {};
  const gates: (GateRun | Error)[] = [];

  // Sandcastle's sandbox on the ticket's branch: a worktree of the shared repo, cut from main for a new branch.
  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const box = {
      worktreePath: path,
      // Git alone: what else the pipeline asks a sandbox (its memory peak) the fake does not have.
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string; promptArgs?: Record<string, string> }) => {
        const name = opts.name ?? "";
        const kind = name.split("-")[0];
        events.push(kind);
        passes.push({ name, args: opts.promptArgs ?? {} });
        const before = git(path, "rev-parse", "HEAD");
        const stdout = agents[kind]?.(path) ?? "";
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout, commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    };
    return box as unknown as Box;
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
    changelog: true,
  } as unknown as Ctx["project"];
  const results: PromiseSettledResult<Outcome>[] = [];
  const requeuedAs = new Map<string, string>();
  const reds = new Map<string, RedLanding>();
  const notes: Ctx["notes"] = [];

  /** A pipeline as burndown() makes one: each call is one attempt of the ticket. */
  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-04T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      events.push("gate");
      const next = gates.shift();
      assert.ok(next, "a gate run the test did not expect");
      // A stop mid-gates: the run dies before any result.
      if (next instanceof Error) throw next;
      return next;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, phase, fn) => {
      phases.push(phase);
      return fn();
    },
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs,
    results,
    reds,
    reports: new Map(),
    notes,
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });

  /** One attempt; its result is kept as burndown's attempt keeps it, and the events and phases start afresh. */
  const attempt = async () => {
    events.length = 0;
    passes.length = 0;
    phases.length = 0;
    const { result: o } = await quietly(() => pipeline(ISSUE));
    results.splice(0, results.length, ...results.filter((r) => r.status !== "fulfilled" || r.value.issue !== ID), { status: "fulfilled", value: o });
    return o;
  };
  /** The landing sent the ticket back once: its second attempt is to come. */
  const requeue = () => requeuedAs.set(ID, "requeued: conflicted with #1 at landing");
  /** Another ticket lands on main, changing `file`. */
  const land = (file: string, text: string) => commit(root, file, text, `Merge agent/issue-1 (closes #1)`);
  const tip = (ref: string) => git(root, "rev-parse", ref);
  /** A person commits `file` to the ticket's branch between runs. */
  const onBranch = (file: string, text: string) => {
    const path = join(TMP, `wt${n++}`);
    git(root, "worktree", "add", "-q", path, BRANCH);
    commit(path, file, text);
    git(root, "worktree", "remove", "--force", path);
  };
  /** The kit's base merge, left on the branch by an earlier run: a merge commit nobody has reviewed. */
  const mergeBase = () => {
    const path = join(TMP, `wt${n++}`);
    git(root, "worktree", "add", "-q", path, BRANCH);
    git(path, "merge", "-q", "--no-edit", "main");
    git(root, "worktree", "remove", "--force", path);
  };
  return { root, agents, gates, events, passes, phases, notes, reds, attempt, requeue, land, tip, onBranch, mergeBase };
};

/** An implementer that commits `file`. */
const implementing = (file: string, text = `${file}\n`): Agent => (wt) => {
  commit(wt, file, text);
};

/** A first attempt that implements and reviews, then is stopped while its gates run: no gate result, red or green. */
const stopMidGates = async (h: ReturnType<typeof harness>) => {
  h.agents.impl = implementing("a.txt");
  h.agents.review = () => "";
  h.gates.push(new Error("the run was stopped"));
  await assert.rejects(h.attempt(), /the run was stopped/);
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  const record = readHeads(h.root)[ID];
  assert.equal(record?.reviewed, h.tip(BRANCH), "the review's tip is on record");
  assert.equal(record?.green, undefined, "and no gate result");
  // The next run scripts its own agents: one that runs would say so.
  for (const k of Object.keys(h.agents)) delete h.agents[k];
  h.agents.impl = () => assert.fail("an implement session ran on a reviewed branch");
};

test("a branch reviewed at its tip with no gate result runs the gates, and no implement, on re-run", async () => {
  const h = harness();
  await stopMidGates(h);
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
  assert.equal(o.status, "green");
  assert.equal(readHeads(h.root)[ID]?.green, h.tip(BRANCH), "and the green head is recorded as for any branch");
});

test("a reviewed branch with a base merge on top gets the narrow merge review, then the gates, and no implement", async () => {
  const h = harness();
  await stopMidGates(h);
  const reviewed = h.tip(BRANCH);
  h.land("b.txt", "b\n");
  h.mergeBase();
  assert.notEqual(h.tip(BRANCH), reviewed);
  h.agents.review = () => "";
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
  assert.equal(h.passes[0].args.REVIEW_BASE, reviewed, "the review reads what is new since the reviewed commit");
  assert.equal(o.status, "green");
});

test("a reviewed branch with commits of its own after the review still gets implement", async () => {
  const h = harness();
  await stopMidGates(h);
  h.onBranch("late.txt", "late\n");
  h.agents.impl = implementing("more.txt");
  h.agents.review = () => "";
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
});

test("a branch whose gates ended red at its reviewed tip still gets implement", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.review = () => "";
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("FAIL: first"), red("FAIL: still"));
  const first = await h.attempt();
  assert.equal(first.status, "gate-failed");
  assert.equal(readHeads(h.root)[ID]?.red, h.tip(BRANCH));
  h.agents.impl = implementing("again.txt");
  h.gates.push(GREEN);
  await h.attempt();
  assert.equal(h.events[0], "impl", `a red result is for the implementer: ${h.events.join(", ")}`);
});

test("a reviewed branch keeps its agents' unmet line and changelog lines for the gates-only re-run", async () => {
  const h = harness();
  h.agents.impl = (wt) => {
    commit(wt, "a.txt", "a\n");
    return "<changelog>Added: a key</changelog>";
  };
  h.agents.review = () => "<unmet>The second module still uses the old rule.</unmet>";
  h.gates.push(new Error("the run was stopped"));
  await assert.rejects(h.attempt(), /the run was stopped/);
  h.agents.impl = () => assert.fail("an implement session ran on a reviewed branch");
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
  assert.equal(o.unmet, "The second module still uses the old rule.");
  assert.deepEqual(o.changelog, ["Added: a key"]);
});

test("a branch stopped during the repair of a red gate still gets implement", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.review = () => "";
  // A repair that commits nothing, then the run is stopped while the gates run again: the tip is still the reviewed one.
  h.agents.repair = () => "";
  h.gates.push(red("FAIL: first"), new Error("the run was stopped"));
  await assert.rejects(h.attempt(), /the run was stopped/);
  assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate"]);
  assert.equal(readHeads(h.root)[ID]?.reviewed, h.tip(BRANCH));
  h.agents.impl = implementing("again.txt");
  h.gates.push(GREEN);
  await h.attempt();
  assert.equal(h.events[0], "impl", `a red result is for the implementer: ${h.events.join(", ")}`);
});
