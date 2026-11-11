// The load re-gate (a timeouts-only red under high machine CPU pressure) starts from the red gate, as the in-slot
// re-run of a red does, and keeps the passes before it: a build or e2e gate ahead of the tests is not paid for again.
// Driven through `createPipeline` (src/burndown.ts) with every port faked, as test/pipeline-load-red.test.ts does,
// recording the `from` each `regate` call was asked for. No Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-load-regate-from.test.ts

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

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-pipeline-load-from-"));
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

// Three configured gates, in this order: a build-like `build`, the `test` after it and a `docs` check last.
const CONFIGURED = [
  { name: "build", command: "run-build" },
  { name: "test", command: "run-tests" },
  { name: "docs", command: "run-docs" },
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

// Failing-test lines (pytest's) and the runner's own timeout wording, which `onlyTimeouts` reads test by test.
const TIMEOUT_A = "FAILED tests/a.test.ts::a\nError: Test timed out in 5000ms";

/** A red `test` gate (the second of three) with the machine-wide CPU pressure its pass read. */
const loadRed = (passed: string[] = ["build"]): GateRun => ({ ...red("test", TIMEOUT_A, passed), cpuMachineMean: 70 });

test("a load-made red on the second of three gates re-gates from that gate, with no full gate call, and the result keeps the first gate's pass", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  // The pipeline's own flake re-run is the first `regate`, the load re-gate the second: both start at `test`.
  h.regates.push(loadRed([]), green("test", "docs"));
  h.gates.push(loadRed());
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "regate", "regate"]);
  assert.deepEqual(h.reruns, ["test", "test"]);
  assert.equal(o.status, "green");
  assert.deepEqual(o.gates.map((g) => g.name), ["build", "test", "docs"]);
  assert.ok(o.gates.every((g) => g.pass));
  assert.ok(o.said.some((l) => /#7: test red on test timeouts under machine load \(CPU pressure 70%\) - no repair pass, gating once more/.test(l)), o.said.join("\n"));
});

test("with ctx.regate unset the load re-gate is a full gate call", async () => {
  const h = harness({ regate: false });
  h.agents.impl = implementing("a.txt");
  h.gates.push(loadRed(), green("build", "test", "docs"));
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "gate"]);
  assert.equal(o.status, "green");
});
