// A ticket gate whose re-run goes red on different tests from the first red is a flake each time: the gate runs a
// third time before any repair pass. Driven through `createPipeline` (src/burndown.ts) as
// test/pipeline-red-rerun.test.ts does, with every port faked: a temp repo, a host worktree for the sandbox,
// scripted agents and scripted gate runs. No Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-red-third-run.test.ts

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
const ISSUE = { id: ID, title: "seven", body: "" } as Parameters<ReturnType<typeof createPipeline>>[0];

// Two configured gates, in this order: a build-like `lint` and the `test` after it.
const CONFIGURED = [
  { name: "lint", command: "run-lint" },
  { name: "test", command: "run-tests" },
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
const harness = (options: { testRedGate?: boolean; repair?: number; regate?: boolean; fixes?: FixBoard } = {}) => {
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
const id = (t: string) => `test/x.test.ts::${t}`;
const specRed = (...tests: string[]) => ["✖ failing tests:", ...tests.flatMap((t) => ["test at test/x.test.ts:1:1", `✖ ${t} (1.2ms)`])].join("\n");

test("a re-run red on different tests, then green on a third run, gets no repair pass and keeps the flaked tests", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("beta")), green("test"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "regate"]);
  assert.deepEqual(h.reruns, ["test", "test"]);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 0);
  assert.deepEqual(o.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", true]]);
  assert.deepEqual(o.flaked, [id("alpha"), id("beta")]);
  assert.ok(o.said.some((l) => /different tests/.test(l)), o.said.join("\n"));
});

test("the same holds when the gate run re-ran its red inside its slot", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push({ ...red("test", specRed("beta"), ["lint"]), rerunOf: red("test", specRed("alpha"), ["lint"]) });
  h.regates.push(green("test"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate"]);
  assert.equal(o.status, "green");
  assert.deepEqual(o.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", true]]);
  assert.deepEqual(o.flaked, [id("alpha"), id("beta")]);
});

test("three reds on different tests go to one repair pass that names the failing tests of all three runs", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("beta")), red("test", specRed("gamma", "delta")));
  h.gates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "regate", "repair", "gate", "review"]);
  const repairs = h.passes.filter((p) => p.name === `repair-${ID}`);
  assert.equal(repairs.length, 1);
  const prompt = repairs[0].args.GATE_OUTPUT;
  assert.match(prompt, /run 1: test\/x\.test\.ts::alpha\n/);
  assert.match(prompt, /run 2: test\/x\.test\.ts::beta\n/);
  assert.match(prompt, /run 3: test\/x\.test\.ts::gamma, test\/x\.test\.ts::delta\n/);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 1);
  assert.deepEqual(o.flaked, [id("alpha"), id("beta")], "gamma and delta are still red when the repair starts");
});

test("a re-run that passes the red gate and goes red on a later one goes to repair, with no third run", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("lint", specRed("alpha")));
  h.regates.push(red("test", specRed("x"), ["lint"]));
  h.gates.push(BOTH);
  await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate", "review"]);
  const repairs = h.passes.filter((p) => p.name === `repair-${ID}`);
  assert.doesNotMatch(repairs[0].args.GATE_OUTPUT, /three times|run 1:/);
});

test("a third run red on the same test as the first does not list it as flaked", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("beta")), red("test", specRed("alpha")));
  h.gates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(o.flaked, [id("beta")]);
});

test("a re-run red on a test the first red also named goes to repair after the re-run, as before", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha", "beta"), ["lint"]));
  h.regates.push(red("test", specRed("beta", "gamma")));
  h.gates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate", "review"]);
  const repairs = h.passes.filter((p) => p.name === `repair-${ID}`);
  assert.doesNotMatch(repairs[0].args.GATE_OUTPUT, /run 1:/);
  assert.deepEqual(o.flaked, [id("alpha")]);
});

test("a first red whose test ids cannot be read goes to repair after the re-run, as before", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", "something broke", ["lint"]));
  h.regates.push(red("test", specRed("beta")));
  h.gates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate", "review"]);
  assert.equal(o.flaked, undefined);
});

test("a re-run whose test ids cannot be read goes to repair after the re-run, as before", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", "something broke"));
  h.gates.push(BOTH);
  await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate", "review"]);
});

// What `clip` makes of an output over 32k characters: a marker line between the head and the tail.
const CLIPPED_OUTPUT = (...tests: string[]) => `${specRed(...tests)}\n[... 90000 characters cut ...]\nlast lines`;

test("a re-run whose clipped output carries no whole-output tests gives no flaked entry and no third run", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", CLIPPED_OUTPUT("alpha"), ["lint"]));
  h.regates.push(red("test", CLIPPED_OUTPUT("beta")));
  h.gates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "repair", "gate", "review"]);
  assert.equal(o.flaked, undefined);
});

test("reds with whole-output tests on disjoint ids still get the third run, though their outputs are clipped", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(red("test", CLIPPED_OUTPUT("other"), ["lint"], 1, [id("alpha")]));
  h.regates.push(red("test", CLIPPED_OUTPUT("other"), [], 1, [id("beta")]), green("test"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "regate"]);
  assert.equal(o.status, "green");
  assert.deepEqual(o.flaked, [id("alpha"), id("beta")]);
});

test("a re-run that timed out is not run a third time", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("beta"), [], 124));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate"]);
  assert.equal(o.status, "gate-failed");
});

test("a repair after another ticket's fix was merged in is not told about the three runs", async () => {
  // Another ticket's fix to the third run's red lands while this one is gated: merged in, and the gates run again.
  let land = () => {};
  let asked = 0;
  const fixes = {
    fixing: () => (asked++ === 0 ? (land(), { by: "9", landed: true }) : undefined),
    claim: () => {},
    wait: async () => true,
  } as unknown as FixBoard;
  const h = harness({ fixes });
  land = () => h.land("other.txt", "the other ticket's fix\n");
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("beta")), red("test", specRed("gamma")));
  h.gates.push(red("test", specRed("epsilon"), ["lint"]), BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "regate", "gate", "repair", "gate", "review"]);
  const repairs = h.passes.filter((p) => p.name === `repair-${ID}`);
  assert.equal(repairs.length, 1);
  assert.doesNotMatch(repairs[0].args.GATE_OUTPUT, /ran three times|run 1:/);
  assert.match(repairs[0].args.GATE_OUTPUT, /epsilon/);
  assert.equal(o.status, "green");
});

test("a third red that names no tests is said as such in the repair prompt", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("test", specRed("alpha"), ["lint"]));
  h.regates.push(red("test", specRed("beta")), red("test", "the runner crashed"));
  h.gates.push(BOTH);
  await h.attempt();
  const repairs = h.passes.filter((p) => p.name === `repair-${ID}`);
  assert.match(repairs[0].args.GATE_OUTPUT, /run 3: no test ids in its output\n/);
});

// A gate result that already holds the third run (`rerunOf.rerunOf`, from `thirdOnDisjoint`): the same decisions as
// the regate path, with no `regate` call - the gates ran three times inside one slot.
const chained = (third: GateRun, second: GateRun, first: GateRun): GateRun => ({ ...third, rerunOf: { ...second, rerunOf: first } });

test("a gate result holding three runs, the third green, makes no regate call and keeps the flaked tests", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(chained(green("lint", "test"), red("test", specRed("beta")), red("test", specRed("alpha"), ["lint"])));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 0);
  assert.deepEqual(o.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", true]]);
  assert.deepEqual(o.flaked, [id("alpha"), id("beta")]);
  assert.ok(o.said.some((l) => /test red on different tests from the first red - a flake each time, gating once more with no repair pass/.test(l)), o.said.join("\n"));
  assert.ok(o.said.some((l) => /test red twice on different tests, then green on a third run - a flake, no repair pass/.test(l)), o.said.join("\n"));
});

test("a gate result holding three red runs goes to one repair pass that names the failing tests of all three, with no regate call", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt");
  h.gates.push(chained(red("test", specRed("gamma", "delta")), red("test", specRed("beta")), red("test", specRed("alpha"), ["lint"])));
  h.gates.push(BOTH);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate", "review"]);
  const repairs = h.passes.filter((p) => p.name === `repair-${ID}`);
  assert.equal(repairs.length, 1);
  const prompt = repairs[0].args.GATE_OUTPUT;
  assert.match(prompt, /run 1: test\/x\.test\.ts::alpha\n/);
  assert.match(prompt, /run 2: test\/x\.test\.ts::beta\n/);
  assert.match(prompt, /run 3: test\/x\.test\.ts::gamma, test\/x\.test\.ts::delta\n/);
  assert.equal(o.status, "green");
  assert.deepEqual(o.flaked, [id("alpha"), id("beta")], "gamma and delta are still red when the repair starts");
});
