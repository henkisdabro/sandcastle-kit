// A branch carried into a later run lands land-only, with no reviewer to say again what no gate
// exercises: its head record carries the `<ungated>` line and the prose gap, or the "check by hand"
// note of the closing summary loses them. The pipeline (`createPipeline`, src/burndown.ts) is driven
// through its ports: a temp repo, a host worktree for the sandbox and scripted agents and gate runs.
// No Docker, model, gh or network.
//
//   pnpm test:file test/land-only-ungated.test.ts

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
  const gates: GateRun[] = [];

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
  return { root, agents, gates, events, passes, phases, notes, reds, attempt, requeue, land, tip, onBranch };
};

/** An implementer that commits `file`, saying `say`. */
const implementing = (file: string, say = "", text = `${file}\n`): Agent => (wt) => {
  commit(wt, file, text);
  return say;
};

const SAID = "On the deployed site, step every journey and watch the console.";

test("a branch carried into a later run lands land-only and still reports its earlier review's check-by-hand note", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.review = () => `<ungated>${SAID}</ungated>`;
  h.gates.push(GREEN);
  const first = await h.attempt();
  assert.equal(first.ungated, SAID);
  assert.equal(readHeads(h.root)[ID]?.ungated, SAID, "the head record keeps it beside unmet and changelog");

  // A later run: the base moved, the branch is still at its green head. No reviewer speaks again.
  h.land("b.txt", "b\n");
  h.gates.push(GREEN);
  const later = await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
  assert.equal(later.ungated, SAID);
  assert.equal(readHeads(h.root)[ID]?.ungated, SAID, "and keeps it through the new green head");
});

test("a carried branch also keeps a gap its reviewer described in prose", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.review = () => "The second module remains on the old rule, and no ticket covers it.";
  h.gates.push(GREEN);
  const first = await h.attempt();
  assert.ok(first.gap, "the first run's outcome has the gap");
  h.land("b.txt", "b\n");
  h.gates.push(GREEN);
  const later = await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
  assert.equal(later.gap, first.gap);
  assert.equal(readHeads(h.root)[ID]?.gap, first.gap);
});

test("a later full review that has nothing for a person to check drops the earlier note", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.review = () => `<ungated>${SAID}</ungated>`;
  h.gates.push(GREEN);
  await h.attempt();
  h.onBranch("note.txt", "a person's commit\n");
  h.agents.impl = implementing("a.txt", "", "a, finished\n");
  h.agents.review = () => "";
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  assert.equal(o.ungated, undefined);
  assert.equal(readHeads(h.root)[ID]?.ungated, undefined);
});
