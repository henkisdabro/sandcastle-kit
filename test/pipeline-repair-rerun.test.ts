// What a repair pass is told to run after a commit: the failing tests (the gate's `rerun` command filled with
// them), not the gate's full command, which the orchestrator runs when the pass exits. Driven through
// `createPipeline` (src/burndown.ts) as test/pipeline-red-third-run.test.ts does, with every port faked: a temp
// repo, scripted agents and scripted gate runs; the repair prompt's file names `{{GATE_RERUN}}`. No Docker, model or network.
//
//   pnpm test:file test/pipeline-repair-rerun.test.ts

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
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type GateRun = import("../src/gates.ts").GateRun;
type RedLanding = import("../src/landing.ts").RedLanding;
type FixBoard = import("../src/schedule.ts").FixBoard;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-repair-rerun-"));
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
const ISSUE = { id: ID, title: "seven", body: "" } as Parameters<ReturnType<typeof createPipeline>>[0];

// Two configured gates, in this order: a build-like `lint` and the `test` after it.
const CONFIGURED = [
  { name: "lint", command: "run-lint" },
  { name: "test", command: "run-tests", rerun: "run-tests {tests}" },
];

/** A gate run that passed the gates named in `passed`, then went red on `name`. */
const red = (name: string, output: string, passed: string[] = [], exitCode = 1, tests?: string[]): GateRun => {
  const failure = { name, command: CONFIGURED.find((g) => g.name === name)!.command, exitCode, output, ...(tests ? { tests } : {}) };
  return { gates: [...passed.map((p) => ({ name: p, pass: true })), { name, pass: false, ...(exitCode === 124 ? { timedOut: true } : {}) }], failure, failures: [failure] };
};
/** A gate run that passed the gates named, from whichever gate it started at. */
const green = (...names: string[]): GateRun => ({ gates: names.map((name) => ({ name, pass: true })), failures: [] });
const BOTH = green("lint", "test");

type Agent = (worktree: string) => string | void;

/**
 * A project in a temp repo and a pipeline over it, with every port faked. `events` is each agent pass, gate
 * run (`gate`) and re-run (`regate`) in order; `reruns` the gate each re-run was asked to start from.
 */
const harness = (options: { testRedGate?: boolean; repair?: number; regate?: boolean; fixes?: FixBoard; gates?: { name: string; command: string; rerun?: string }[] } = {}) => {
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
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_RERUN}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const events: string[] = [];
  const passes: { name: string; args: Record<string, string> }[] = [];
  const agents: Record<string, Agent> = {};
  const gates: GateRun[] = [];
  const regates: GateRun[] = [];
  const reruns: string[] = [];

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
    gates: options.gates ?? CONFIGURED,
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

  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-09T00:00:00.000Z",
    dryRun: false,
    repair: options.repair ?? 1,
    testRedGate: options.testRedGate ?? false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      events.push("gate");
      const next = gates.shift();
      assert.ok(next, "a gate run the test did not expect");
      return next;
    },
    ...(options.regate === false
      ? {}
      : {
          regate: async (_box: Box, _id: string, from: string) => {
            events.push("regate");
            reruns.push(from);
            const next = regates.shift();
            assert.ok(next, "a gate re-run the test did not expect");
            return next;
          },
        }),
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, _phase, fn) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs,
    results,
    reds,
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
    ...(options.fixes ? { fixes: options.fixes } : {}),
  });

  /** One attempt; its result is kept as burndown's attempt keeps it, and what the test reads starts afresh. */
  const attempt = async () => {
    events.length = 0;
    passes.length = 0;
    reruns.length = 0;
    const { result: o, lines } = await quietly(() => pipeline(ISSUE));
    results.splice(0, results.length, ...results.filter((r) => r.status !== "fulfilled" || r.value.issue !== ID), { status: "fulfilled", value: o });
    return Object.assign(o, { said: lines });
  };
  const requeue = () => requeuedAs.set(ID, "requeued: conflicted with #1 at landing");
  const land = (file: string, text: string) => commit(root, file, text, `Merge agent/issue-1 (closes #1)`);
  const tip = (ref: string) => git(root, "rev-parse", ref);
  return { agents, gates, regates, events, passes, reruns, reds, attempt, requeue, land, tip };
};

/** An implementer that commits `file`, saying nothing. */
const implementing = (file: string, text = `${file}\n`): Agent => (wt) => {
  commit(wt, file, text);
};

// node:test's spec output: the failing tests are listed under "failing tests:".
const specRed = (...tests: string[]) => ["✖ failing tests:", ...tests.flatMap((t) => ["test at test/x.test.ts:1:1", `✖ ${t} (1.2ms)`])].join("\n");


const repairArgs = (h: ReturnType<typeof harness>) => h.passes.filter((p) => p.name === `repair-${ID}`).map((p) => p.args);

test("a red on the pipeline's own re-run path gets the rerun command filled with the failing tests", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("alpha", "beta")));
  h.gates.push(BOTH);
  await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate", "review"]);
  const [args] = repairArgs(h);
  assert.match(args.GATE_RERUN, /\n {2}run-tests 'test\/x\.test\.ts::alpha' 'test\/x\.test\.ts::beta'\n/);
  assert.equal(args.GATE_COMMAND, "run-tests", "the red gate's own command stays the one the \"Find every failure first\" run uses");
});

test("a red after a repair commit gets the command filled again with that red's tests", async () => {
  const h = harness({ repair: 2 });
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("alpha")));
  h.gates.push(red("test", specRed("gamma"), ["lint"]), BOTH);
  await h.attempt();
  const args = repairArgs(h);
  assert.equal(args.length, 2);
  assert.match(args[0].GATE_RERUN, /\n {2}run-tests 'test\/x\.test\.ts::alpha'\n/);
  assert.match(args[1].GATE_RERUN, /\n {2}run-tests 'test\/x\.test\.ts::gamma'\n/);
  assert.doesNotMatch(args[1].GATE_RERUN, /alpha/);
});

test("a three-run red on disjoint tests fills the union of all three runs' tests", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("beta")), red("test", specRed("gamma", "delta")));
  h.gates.push(BOTH);
  await h.attempt();
  const [args] = repairArgs(h);
  const x = (t: string) => `'test/x.test.ts::${t}'`;
  assert.ok(args.GATE_RERUN.includes(`run-tests ${[x("alpha"), x("beta"), x("gamma"), x("delta")].join(" ")}\n`), args.GATE_RERUN);
  assert.equal(args.GATE_COMMAND, "run-tests");
});

test("a red lint gate is told to run its own command after a commit", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("lint", "src/a.ts: unused variable"));
  h.regates.push(red("lint", "src/a.ts: unused variable"));
  h.gates.push(BOTH);
  await h.attempt();
  const [args] = repairArgs(h);
  assert.match(args.GATE_RERUN, /this gate's own command, `run-lint`/);
  assert.doesNotMatch(args.GATE_RERUN, /run-tests/);
});

test("a test gate with no rerun command is told to run the failing tests' files by its own runner", async () => {
  const h = harness({ gates: [{ name: "lint", command: "run-lint" }, { name: "test", command: "run-tests" }] });
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("alpha")));
  h.gates.push(BOTH);
  await h.attempt();
  const [args] = repairArgs(h);
  assert.match(args.GATE_RERUN, /the failing tests' files, by the test runner `run-tests` names, not the whole command/);
});
