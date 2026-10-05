// The base-red tests' project (test/base-red-*.test.ts): one pipeline per branch (`createPipeline`,
// src/burndown.ts) over a temp repo, a scripted agent and scripted gate runs, with the base's gate run a fake.
// No Docker, model, gh or network.
//
// Import it before anything from src/: it points the kit's directories at temp ones first.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-base-red-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};

export const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
export const red = (output: string): GateRun => {
  const failure = { name: "test", command: "run-tests", exitCode: 1, output };
  return { gates: [{ name: "test", pass: false }], failure, failures: [failure] };
};
export const CLOCK = red("FAIL  test/clock.test.ts > rolls over at midnight\n1 failed");

/**
 * A project in a temp repo with every port faked; `gateOf` says what each ticket's gate run returns, in order.
 * `baseRun` is what the base's gate run returns, or a function of the repo's root that gives it (and may land
 * a commit on the base first, as another ticket's landing would); the run says the base commit it gated.
 */
export const harness = (gateOf: (id: string) => GateRun[], baseRun: GateRun | ((root: string) => GateRun) = CLOCK) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "test/clock.test.ts", "start\n");
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const repairs: string[] = [];
  const baseRuns: string[] = [];
  const toldRed: string[][] = [];
  const lines: string[] = [];
  const gates = new Map<string, GateRun[]>();
  const agents: Record<string, (id: string, worktree: string) => void> = {
    impl: (id, wt) => commit(wt, `src/ticket-${id}.ts`, `${id}\n`),
  };

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
      run: async (opts: { name?: string }) => {
        const [kind, id] = (opts.name ?? "").split("-");
        if (kind === "repair") repairs.push(id);
        const before = git(path, "rev-parse", "HEAD");
        agents[kind]?.(id, path);
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
    root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }],
    generated: [], setup: [], implement: {}, review: {}, repair: {}, changelog: true,
  } as unknown as Ctx["project"];
  const log = console.log;
  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-05T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async (_box, id) => {
      const queue = gates.get(id) ?? gateOf(id);
      gates.set(id, queue);
      const next = queue.shift();
      assert.ok(next, `a gate run of ${id} the test did not expect`);
      return next;
    },
    baseGate: async () => {
      const result = typeof baseRun === "function" ? baseRun(root) : baseRun;
      const head = git(root, "rev-parse", "main");
      baseRuns.push(head);
      // Slow enough that three branches asking at once share the one run.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ...result, head };
    },
    baseWentRed: (tests) => toldRed.push(tests),
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
  const attempt = async (id: string): Promise<Outcome> => {
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      return await pipeline({ id, title: `ticket ${id}`, body: "" } as Parameters<typeof pipeline>[0]);
    } finally {
      console.log = log;
    }
  };
  return { root, agents, repairs, baseRuns, toldRed, lines, attempt };
};
