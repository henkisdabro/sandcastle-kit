// What a sandbox's peaks line says about its phases (src/peaks.ts): `anonMib` is the anonymous memory read
// while a gate pass ran, `agentAnonMib` while an agent pass ran, and `agentMib` the `memory.peak` before the
// first gate. The sandbox is a fake `exec` whose kernel files answer by the phase it is in, the sampler's
// 10-second clock is node:test's mock timers, and a ticket's pipeline runs over a temp repo as in
// test/pipeline.test.ts. No Docker, model, gh or network.
//
//   pnpm test:file test/peaks-sampling.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { PEAKS_FILE, projectId, readPeaks, recordPeak } = await import("../src/peaks.ts");
const { runGates } = await import("../src/gates.ts");
const { createPipeline } = await import("../src/burndown.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-peaks-sampling-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const MIB = 2 ** 20;

// Only the sampler's interval is mocked: the reads' own time limits and the gate's bound stay real (and are cleared).
beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
afterEach(() => mock.timers.reset());
const settle = () => new Promise((resolve) => setImmediate(resolve));
/**
 * Ten seconds pass on the sampler's clock, and the read it started answers. The read before them (a phase's first, taken as
 * it starts) has answered by then, as a sandbox's does in milliseconds: the sampler takes one read at a time.
 */
const tenSeconds = async () => {
  await settle();
  mock.timers.tick(10_000);
  await settle();
};

/**
 * A sandbox's kernel files: `memory.peak` reads `peak` MiB, `memory.stat`'s `anon` reads `anon` MiB
 * (no file when `stat` is false). `reads` counts the `memory.stat` reads.
 */
const kernel = (stat = true) => {
  const k = { peak: 100, anon: 10, stat, reads: 0 };
  const answer = (cmd: string) => {
    if (cmd.includes("memory.peak")) return { exitCode: 0, stdout: `${k.peak * MIB}\n`, stderr: "" };
    // No PSI in this fake kernel: a read of it must not be taken for the gate command (see test/memory-pressure.test.ts).
    if (cmd.includes("memory.pressure")) return { exitCode: 1, stdout: "", stderr: "No such file" };
    if (cmd.includes("memory.stat")) {
      k.reads++;
      return k.stat ? { exitCode: 0, stdout: `file 999999999\nanon ${k.anon * MIB}\nkernel 4096\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "No such file" };
    }
    return undefined;
  };
  return { k, answer };
};

/** A gate that runs for 20 s: anon at `during[0]`, then `during[1]`, with the peak at `peak`; at rest after it, anon is `rest`. */
const gateRun = (k: { peak: number; anon: number }, during: [number, number], peak: number, rest: number) => async () => {
  k.peak = peak;
  k.anon = during[0];
  await tenSeconds();
  k.anon = during[1];
  await tenSeconds();
  k.anon = rest;
};

const project = (root: string) => ({ name: "made-up", root, gates: [{ name: "test", command: "run-tests" }] }) as Parameters<typeof runGates>[0];

test("a gate pass's anonMib is the highest anon read while it ran, not the sandbox at rest after it", async () => {
  const { k, answer } = kernel();
  const gate = gateRun(k, [700, 1200], 3000, 40);
  const box = {
    worktreePath: "/made-up",
    exec: async (cmd: string) => answer(cmd) ?? (await gate(), { exitCode: 0, stdout: "", stderr: "" }),
  };
  const run = await runGates(project(TMP), box, "gates");
  assert.equal(run.gates[0].pass, true);
  assert.equal(run.peakMib, 3000);
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  // At close the sandbox is at rest with more anon than its gate used: that reading describes no phase.
  k.anon = 5000;
  assert.equal(await recordPeak(box, TMP, "run-1", file, new Date("2026-10-05T10:00:00Z")), 3000);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ts: "2026-10-05T10:00:00.000Z", project: projectId(TMP), run: "run-1", peakMib: 3000, sampled: 2, anonMib: 1200 });
});

test("a base or verify sandbox's line (gates, then close) has no agent fields", async () => {
  const { k, answer } = kernel();
  const gate = gateRun(k, [900, 800], 2500, 30);
  const box = { worktreePath: "/made-up", exec: async (cmd: string) => answer(cmd) ?? (await gate(), { exitCode: 0, stdout: "", stderr: "" }) };
  await runGates(project(TMP), box, "base", true);
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  await recordPeak(box, TMP, "run-1", file);
  const [line] = readPeaks(file);
  assert.equal(line.anonMib, 900);
  assert.ok(!("agentMib" in line) && !("agentAnonMib" in line), JSON.stringify(line));
});

test("a sandbox with no memory.stat still writes its peakMib line, and the gate passes", async () => {
  const { k, answer } = kernel(false);
  const gate = gateRun(k, [900, 800], 1800, 30);
  const box = { worktreePath: "/made-up", exec: async (cmd: string) => answer(cmd) ?? (await gate(), { exitCode: 0, stdout: "", stderr: "" }) };
  const run = await runGates(project(TMP), box, "gates");
  assert.equal(run.gates[0].pass, true);
  const file = join(mkdtempSync(join(tmpdir(), "sandcastle-peaks-file-")), "peaks.jsonl");
  assert.equal(await recordPeak(box, TMP, "run-1", file), 1800);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), ["peakMib", "project", "run", "sampled", "ts"]);
});

test("no sampler outlives its gate pass, even one whose gate throws", async () => {
  const { k, answer } = kernel();
  const box = {
    worktreePath: "/made-up",
    exec: async (cmd: string) => {
      const known = answer(cmd);
      if (known) return known;
      await tenSeconds();
      throw new Error("sandbox gone");
    },
  };
  await assert.rejects(runGates(project(TMP), box, "gates"), /sandbox gone/);
  const reads = k.reads;
  assert.ok(reads >= 1, "the sampler read while the gate ran");
  await tenSeconds();
  await tenSeconds();
  assert.equal(k.reads, reads, "no read after the pass ended");
});

// ---- a ticket's pipeline ----

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};

test("a ticket's line: agentMib is the peak before the first gate, agentAnonMib the agents' highest anon, anonMib the gates'", async () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n");
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const { k, answer } = kernel();
  const events: string[] = [];
  // Each agent pass: anon at two readings 10 s apart, with the peak it leaves.
  const agents: Record<string, { anon: [number, number]; peak: number; file?: string }> = {
    impl: { anon: [300, 500], peak: 2000, file: "a.txt" },
    review: { anon: [400, 350], peak: 2100 },
    repair: { anon: [600, 450], peak: 2200, file: "fix.txt" },
  };
  // The first gate red, then green; each runs at anon 1500, then 1100 and 1200, and lifts the peak.
  const gates = [
    { exitCode: 1, run: gateRun(k, [1500, 1000], 5000, 20) },
    { exitCode: 0, run: gateRun(k, [1100, 1200], 5200, 20) },
  ];
  let agentMibAtFirstGate: number | undefined;
  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const box = {
      worktreePath: path,
      exec: async (cmd: string) => {
        const known = answer(cmd);
        if (known) return known;
        if (cmd.startsWith("git ")) {
          const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
          return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
        }
        const g = gates.shift();
        assert.ok(g, `a command the test did not expect: ${cmd}`);
        events.push("gate");
        agentMibAtFirstGate ??= k.peak;
        await g.run();
        return { exitCode: g.exitCode, stdout: g.exitCode ? "boom" : "", stderr: "" };
      },
      run: async (opts: { name?: string }) => {
        const kind = (opts.name ?? "").split("-")[0];
        events.push(kind);
        const a = agents[kind];
        const before = git(path, "rev-parse", "HEAD");
        if (a) {
          k.anon = a.anon[0];
          await tenSeconds();
          k.anon = a.anon[1];
          await tenSeconds();
          k.peak = Math.max(k.peak, a.peak);
          k.anon = 30;
          if (a.file) commit(path, a.file, `${kind}\n`);
        }
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    };
    return box as unknown as Box;
  };
  const p = {
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
  const runId = "2026-10-05T09:00:00.000Z";
  const pipeline = createPipeline({
    project: p,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId,
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: (box) => runGates(p, box, "fixture #7"),
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
  const { result: outcome } = await quietly(() => pipeline({ id: "7", title: "seven", body: "" } as Parameters<typeof pipeline>[0]));
  assert.deepEqual(events, ["impl", "review", "gate", "repair", "gate", "review"]);
  assert.equal(outcome.status, "green");
  assert.equal(agentMibAtFirstGate, 2100);

  const mine = readPeaks(PEAKS_FILE).filter((l) => l.run === runId);
  assert.equal(mine.length, 1);
  const { ts: _ts, project: _project, ...figures } = mine[0];
  // agentMib stays the peak before the first gate (2100), though later passes and gates lifted it to 5200;
  // agentAnonMib is the repair's 600, the highest of implement, review and repair; anonMib the first gate's 1500.
  assert.deepEqual(figures, { run: runId, peakMib: 5200, sampled: 2, anonMib: 1500, agentMib: 2100, agentAnonMib: 600 });

  const reads = k.reads;
  await tenSeconds();
  await tenSeconds();
  assert.equal(k.reads, reads, "no sampler outlives the pipeline's passes");
});
