// An attempt's first red gate is run again once, from the red gate on, before any repair pass: a red that was
// only the machine being busy would otherwise cost a whole model pass that finds nothing to fix. Driven through
// `createPipeline` (src/burndown.ts) with every port faked, as test/pipeline.test.ts does: a temp repo, a
// host worktree for the sandbox whose `run` is a scripted agent, scripted gate runs and re-runs. No Docker,
// model, gh or network. `runGates`' own start-from-a-gate is held against a fake sandbox at the end.
//
//   pnpm test:file test/pipeline-red-rerun.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { runGates } = await import("../src/gates.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type GateRun = import("../src/gates.ts").GateRun;
type RedLanding = import("../src/landing.ts").RedLanding;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-pipeline-rerun-"));
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

// Two configured gates, in this order: a build-like `lint` and the `test` after it.
const CONFIGURED = [
  { name: "lint", command: "run-lint" },
  { name: "test", command: "run-tests" },
];

/** A gate run that passed the gates named in `passed`, then went red on `name`. */
const red = (name: string, output: string, passed: string[] = [], exitCode = 1): GateRun => {
  const failure = { name, command: CONFIGURED.find((g) => g.name === name)!.command, exitCode, output };
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
const harness = (options: { testRedGate?: boolean; repair?: number; regate?: boolean } = {}) => {
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
    gates: CONFIGURED,
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

test("a red first gate that is green on its re-run gets no repair pass, and the ticket goes on as green with both gates passed", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(red("lint", "FAIL: lint timed out under load"));
  h.regates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate"]);
  assert.deepEqual(h.reruns, ["lint"], "the re-run starts at the first gate");
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 0);
  assert.deepEqual(o.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", true]]);
  assert.ok(o.said.includes("#7: lint red, then green on a re-run - a flake, no repair pass"), o.said.join("\n"));
});

test("a red that comes back on the re-run gets one repair pass, fed the re-run's output", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("lint", "FAIL: first run"));
  h.regates.push(red("lint", "FAIL: the re-run, which says something else"));
  h.gates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate", "review"]);
  const repairs = h.passes.filter((p) => p.name === `repair-${ID}`);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0].args.GATE_OUTPUT, /the re-run, which says something else/);
  assert.doesNotMatch(repairs[0].args.GATE_OUTPUT, /first run/);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 1);
});

test("a red on the second gate is re-run from the second gate, and the passes before it stay in the result", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(red("test", "FAIL: a test timed out under load", ["lint"]));
  h.regates.push(green("test"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate"]);
  assert.deepEqual(h.reruns, ["test"], "the re-run starts at the red gate, not the first");
  assert.equal(o.status, "green");
  // A prefix of the configured gates, in their order: `gateResultLines` pairs each result with the gate at its index.
  assert.deepEqual(o.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", true]]);
});

test("a re-run that goes red on a later gate than the first red repairs from that failure, with the passes before it kept", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("lint", "FAIL: lint timed out under load"));
  // The first gate passes this time and the one after it, which never ran on this tree, is red.
  h.regates.push(red("test", "FAIL: a real test failure", ["lint"]));
  h.gates.push(BOTH);
  await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate", "review"]);
  const repair = h.passes.find((p) => p.name === `repair-${ID}`);
  assert.equal(repair?.args.GATE_NAME, "test");
  assert.match(repair?.args.GATE_OUTPUT ?? "", /a real test failure/);
});

/** A green first attempt, then a red landing gate on the base tip it merged with: what the requeue reads. */
const redAtLanding = async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(BOTH);
  assert.equal((await h.attempt()).status, "green");
  h.land("b.txt", "b\n");
  const landing = red("test", "FAIL: a.txt and b.txt cannot both exist", ["lint"]);
  h.reds.set(ID, { head: h.tip(BRANCH), base: h.tip("main"), failure: landing.failure!, gates: landing.gates });
  h.requeue();
  h.agents.repair = (wt) => {
    git(wt, "rm", "-q", "b.txt");
    git(wt, "commit", "-q", "-m", "keep a.txt alone");
  };
  return h;
};

test("a requeue on the base its landing gate went red on re-runs the red gate before any repair, and a green re-run means no repair", async () => {
  const h = await redAtLanding();
  h.regates.push(green("test"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["regate"], "no full gate run, no repair pass");
  assert.deepEqual(h.reruns, ["test"]);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 0);
  assert.deepEqual(o.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", true]]);
  assert.ok(o.said.some((l) => /test went red at landing - no full gate run; test is re-run first/.test(l)), o.said.join("\n"));
  assert.ok(o.said.includes("#7: test red, then green on a re-run - a flake, no repair pass"), o.said.join("\n"));
});

test("a requeue whose re-run is red again repairs from the re-run's output", async () => {
  const h = await redAtLanding();
  h.regates.push(red("test", "FAIL: a.txt and b.txt cannot both exist (the re-run)", ["lint"]));
  h.gates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["regate", "repair", "gate", "review"]);
  const repair = h.passes.find((p) => p.name === `repair-${ID}`);
  assert.match(repair?.args.GATE_OUTPUT ?? "", /\(the re-run\)/);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 1);
});

test("a requeue on a base that moved since its landing gate went red runs the gates in full, and a red there is re-run from its gate", async () => {
  const h = await redAtLanding();
  h.land("c.txt", "c\n");
  h.gates.push(red("test", "FAIL: flaked", ["lint"]));
  h.regates.push(green("test"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["gate", "regate"]);
  assert.deepEqual(h.reruns, ["test"]);
  assert.equal(o.status, "green");
});

test("a gate that timed out is not run again, and is not repaired", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(red("test", "The gate timed out after 30 min", ["lint"], 124));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  assert.equal(o.status, "gate-failed");
});

test("SANDCASTLE_TEST_RED_GATE's forced red goes straight to the repair pass it exists to exercise", async () => {
  const h = harness({ testRedGate: true });
  h.agents.impl = implementing("a.txt");
  h.gates.push(BOTH, BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate"]);
  assert.equal(o.status, "green");
});

test("a red after a repair pass is not run again", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("lint", "FAIL: lint, still"));
  h.regates.push(red("lint", "FAIL: lint, still"));
  h.gates.push(red("lint", "FAIL: lint, still"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate"], "one re-run, before the repair, and none after it");
  assert.equal(o.status, "gate-failed");
});

test("a run with repair passes off does not re-run a red: nothing would follow it", async () => {
  const h = harness({ repair: 0 });
  h.agents.impl = implementing("a.txt");
  h.gates.push(red("lint", "FAIL: lint"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  assert.equal(o.status, "gate-failed");
});

test("a pipeline given no re-run repairs at once, as it did", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("lint", "FAIL: lint"), BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate", "review"]);
  assert.equal(o.status, "green");
});

// burndown() needs Docker, so no test drives it: the call site is held by its text.
test("burndown() hands createPipeline the re-run port, built on its own runGates from the red gate", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /createPipeline\(\{[\s\S]*?regate: \(box, id, from\) => runGates\(box, id, undefined, false, from\),/);
  // A re-run is a ticket's gate run, never the landing's priority one: it waits for a gates slot behind a landing gate.
  assert.doesNotMatch(src, /regate: \(box, id, from\) => runGates\([^)]*true/);
});

// runGates itself: the gate to start from, with the configured numbering in its log and progress.
const three = [
  { name: "build", command: "run-build" },
  { name: "lint", command: "run-lint" },
  { name: "test", command: "run-tests" },
];
const gatesRun = async (from?: string, redOn?: string) => {
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "gates.log");
  const project = { name: "fixture", gates: three } as Parameters<typeof runGates>[0];
  const ran: string[] = [];
  const shown: [number, string][] = [];
  const sandbox = {
    exec: async (cmd: string) => {
      const gate = three.find((g) => cmd.includes(g.command));
      if (gate) ran.push(gate.name);
      return { exitCode: gate && gate.name === redOn ? 1 : 0, stdout: "", stderr: "" };
    },
  };
  const result = await runGates(project, sandbox, "fixture gates", false, { log, gate: (i, name) => void shown.push([i, name]) }, false, from);
  return { result, ran, shown, log: readFileSync(log, "utf8") };
};

test("runGates from a named gate runs that gate and each one after it, in config order, with the configured numbering", async () => {
  const { result, ran, shown, log } = await gatesRun("lint");
  assert.deepEqual(ran, ["lint", "test"]);
  assert.deepEqual(shown, [[1, "lint"], [2, "test"]]);
  assert.deepEqual(result.gates.map((g) => g.name), ["lint", "test"]);
  assert.match(log, /# gate 2\/3: lint, /);
  assert.match(log, /# gate 3\/3: test, /);
  assert.doesNotMatch(log, /gate 1\/3/);
});

test("runGates from a gate stops at the first red after it, as a full run does", async () => {
  const { result, ran } = await gatesRun("lint", "lint");
  assert.deepEqual(ran, ["lint"]);
  assert.equal(result.failure?.name, "lint");
});

test("runGates given no gate, or one that is not configured, starts at the first", async () => {
  assert.deepEqual((await gatesRun()).ran, ["build", "lint", "test"]);
  assert.deepEqual((await gatesRun("nothing-of-the-kind")).ran, ["build", "lint", "test"]);
});
