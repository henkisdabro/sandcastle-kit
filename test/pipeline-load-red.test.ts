// A ticket gate that went red only on test timeouts while the machine's CPU pressure was high gets one more gate run
// instead of a repair pass: there is nothing in the branch to repair. Driven through `createPipeline` (src/burndown.ts)
// with every port faked, as test/pipeline-red-rerun.test.ts does: scripted gate runs carrying `cpuMachineMean`. No
// Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-load-red.test.ts

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

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-pipeline-load-"));
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
  { name: "test", command: "run-tests" },
];

/** A gate run that passed the gates named in `passed`, then went red on `name`. */
const red = (name: string, output: string, passed: string[] = [], exitCode = 1): GateRun => {
  const failure = { name, command: CONFIGURED.find((g) => g.name === name)!.command, exitCode, output };
  return { gates: [...passed.map((p) => ({ name: p, pass: true })), { name, pass: false, ...(exitCode === 124 ? { timedOut: true } : {}) }], failure, failures: [failure] };
};
/** A gate run that passed the gates named, from whichever gate it started at. */
const green = (...names: string[]): GateRun => ({ gates: names.map((name) => ({ name, pass: true })), failures: [] });

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

const { describe } = await import("../src/ledger.ts");

// Failing-test lines (pytest's) and the runner's own timeout wording, which `onlyTimeouts` reads test by test.
const TIMEOUT_A = "FAILED tests/a.test.ts::a\nError: Test timed out in 5000ms";
const ASSERT_B = "FAILED tests/b.test.ts::b\nAssertionError: expected 1 to be 2";

/** A red `test` gate, with the machine-wide CPU pressure its pass read. */
const loaded = (output: string, cpu?: number, extra: Partial<GateRun> = {}, exitCode = 1): GateRun => ({
  ...red("test", output, ["lint"], exitCode),
  ...(cpu === undefined ? {} : { cpuMachineMean: cpu }),
  ...extra,
});
const GREEN_TEST = green("lint", "test");
const LOAD_LINE = /#7: test red on test timeouts under machine load \(CPU pressure 70%\) - no repair pass, gating once more/;

test("a timeouts-only red at high machine CPU pressure gets no repair pass and one more gate run, and green there ends the ticket green", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.gates.push(loaded(TIMEOUT_A, 70), GREEN_TEST);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "gate"]);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 0);
  assert.equal(o.loadRed, undefined);
  assert.ok(o.said.some((l) => LOAD_LINE.test(l)), o.said.join("\n"));
});

test("the same red after the pipeline's own re-run goes to the load re-gate, not the repair", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(loaded(TIMEOUT_A, 70));
  h.regates.push(loaded(TIMEOUT_A, 70));
  h.gates.push(GREEN_TEST);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "gate"]);
  assert.equal(o.status, "green");
});

test("a load re-gate that is red on timeouts at high pressure again ends gate-failed with loadRed, no repair pass and no third gate call, and the ledger says machine load", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.gates.push(loaded(TIMEOUT_A, 70), loaded(TIMEOUT_A, 75));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "gate"]);
  assert.equal(o.status, "gate-failed");
  assert.equal(o.loadRed, true);
  assert.equal(o.repairs, 0);
  const said = describe({ kind: "pipeline", outcome: o, attempts: 1 } as Parameters<typeof describe>[0], { base: "main", gateNames: "lint, test" });
  assert.equal(said.record!.state, "red");
  assert.match(said.record!.note ?? "", /test red - test timeouts under machine load, not repaired; run it again when the machine is quiet/);
});

test("a load re-gate that goes red on an assertion failure gets the repair pass as today", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(loaded(TIMEOUT_A, 70), loaded(ASSERT_B, 70), GREEN_TEST);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "gate", "repair", "gate", "review"]);
  const repair = h.passes.find((p) => p.name === `repair-${ID}`);
  assert.match(repair?.args.GATE_OUTPUT ?? "", /AssertionError/);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 1);
});

test("a load re-gate that is red on timeouts after the pressure fell gets the repair pass as today", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(loaded(TIMEOUT_A, 70), loaded(TIMEOUT_A, 59.9), GREEN_TEST);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "gate", "repair", "gate", "review"]);
  assert.equal(o.loadRed, undefined);
});

test("a timeouts-only red with no CPU figure, or at 59.9, gets its repair pass with no load re-gate", async () => {
  for (const cpu of [undefined, 59.9]) {
    const h = harness({ regate: false });
    h.agents.impl = implementing("a.txt");
    h.agents.repair = implementing("fix.txt");
    h.gates.push(loaded(TIMEOUT_A, cpu), GREEN_TEST);
    const o = await h.attempt();
    assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate", "review"], `cpu ${cpu}`);
    assert.equal(o.status, "green");
  }
});

test("a red with an assertion failure beside timeouts at high pressure gets its repair pass", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(loaded(`${TIMEOUT_A}\n${ASSERT_B}`, 70), GREEN_TEST);
  await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate", "review"]);
});

test("with repair attempts 0 there is no load re-gate", async () => {
  const h = harness({ regate: false, repair: 0 });
  h.agents.impl = implementing("a.txt");
  h.gates.push(loaded(TIMEOUT_A, 70));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  assert.equal(o.status, "gate-failed");
  assert.equal(o.loadRed, undefined);
});

test("a gate that hit its own time bound at high pressure gets no load re-gate", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.gates.push(loaded("Error: Test timed out in 5000ms\nThe gate timed out after 30 min", 70, {}, 124));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  assert.equal(o.status, "gate-failed");
  assert.equal(o.loadRed, undefined);
});

test("a forced red (SANDCASTLE_TEST_RED_GATE) is not a load re-gate", async () => {
  const h = harness({ testRedGate: true, regate: false });
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push({ ...GREEN_TEST, cpuMachineMean: 70 }, GREEN_TEST);
  await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate", "review"]);
});

test("a red a re-run inside the slot repeated, then green on the load re-gate, is green and its flaked tests do not name the timed-out one", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  // What `runGates` returns for `rerunOnRed`: the re-run's result, carrying the first red.
  h.gates.push({ ...loaded(TIMEOUT_A, 70), rerunOf: loaded(TIMEOUT_A, 70) }, GREEN_TEST);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "gate"]);
  assert.equal(o.status, "green");
  assert.equal(o.flaked, undefined, `flaked: ${JSON.stringify(o.flaked)}`);
});

test("a flake of another test in the same chain is still recorded when the load red names only the timed-out one", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  const other = "FAILED tests/c.test.ts::c\nAssertionError: expected 1 to be 2";
  h.gates.push({ ...loaded(TIMEOUT_A, 70), rerunOf: loaded(`${other}\n${TIMEOUT_A}`, 70) }, GREEN_TEST);
  const o = await h.attempt();
  assert.deepEqual(o.flaked, ["tests/c.test.ts::c"]);
});

test("a load-made red on the macOS estimate says the figure is an estimate", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.gates.push(loaded(TIMEOUT_A, 70, { cpuEstimate: true }), GREEN_TEST);
  const o = await h.attempt();
  assert.ok(o.said.includes("#7: test red on test timeouts under machine load (CPU pressure 70%, an estimate from the load average) - no repair pass, gating once more"), o.said.join("\n"));
});
