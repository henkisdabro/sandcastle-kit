// The run's estimate prices the whole run, not only the tickets' pipelines: a chain's landings (a
// dependant starts only once its blocker has landed) and the last ticket's, the base gates before
// every ticket and verify after the last. Its line names the history tickets that priced the run, not
// the window's. And a ticket that waited for another's fix (`createPipeline` over a fix board) books
// that wait apart from its time, as a slot wait is, so it does not inflate later usual times. Made-up
// timings, a temp repo, scripted agents and gate runs, a moved clock; no tracker, Docker or network.
//
//   node --test test/estimate-whole-run.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merges pass process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { estimate } = await import("../src/run.ts");
const { createPipeline } = await import("../src/burndown.ts");
const { createFixBoard } = await import("../src/schedule.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = Parameters<typeof estimate>[0];
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-estimate-whole-run-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const MIN = 60_000;
const tokens = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });
const history = (lines: string[]) => {
  const root = mkdtempSync(join(TMP, "estimate-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture", tracker: fakeTracker() } as unknown as Project;
};

// One history ticket: a 10-minute pipeline, then 2 minutes of landing gates.
const landed = () => [line({ issue: "1", phase: "implement", ms: 10 * MIN, tokens }), line({ issue: "1", phase: "landing gates", ms: 2 * MIN })];

test("a two-ticket chain takes both pipelines, the landing between them and the final landing", () => {
  const p = history(landed());
  // 10m + 2m landing, then the dependant's 10m + 2m landing: 24m, not the 20m of the pipelines alone.
  assert.match(estimate(p, 2, 5, 2, undefined, { chainAt: [0, 1] })!, /and 24m for 2 ticket\(s\), 5 at a time \(2 tickets in sequence\)\.(?: No history at .*)?$/);
});

test("tickets side by side end with the last one's landing", () => {
  const p = history(landed());
  // Two 10m pipelines at once, then a 2m landing.
  assert.match(estimate(p, 2, 5)!, /and 12m for 2 ticket\(s\), 5 at a time\.(?: No history at .*)?$/);
});

test("the base gates before the tickets and verify after them are in the time", () => {
  const p = history([
    line({ issue: "1", phase: "implement", ms: 10 * MIN, tokens }),
    line({ issue: 0, phase: "base gates", ms: 1 * MIN }),
    line({ issue: 0, phase: "verify", ms: 1 * MIN }),
    // Steps of the run that are neither are not its gates.
    line({ issue: 0, phase: "image", ms: 30 * MIN }),
  ]);
  assert.match(estimate(p, 1, 1)!, /and 12m for 1 ticket\(s\), 1 at a time\.(?: No history at .*)?$/);
});

test("the line names the tickets that priced the run, not the window's", () => {
  // Five tickets of one model and three of another: a run on the first is priced from its five.
  const p = history([
    ...["1", "2", "3", "4", "5"].map((issue) => line({ issue, phase: "implement", model: "model-a", ms: 10 * MIN, tokens })),
    ...["6", "7", "8"].map((issue) => line({ issue, phase: "implement", model: "model-b", ms: 40 * MIN, tokens })),
  ]);
  assert.match(estimate(p, 2, 2, 0, ["model-a", "model-a"])!, /^Estimate \(rough, from 5 ticket\(s\) in the last 3 runs\): .* and 10m for 2 ticket\(s\)/);
});

// A ticket red on a test another ticket is repairing waits for that ticket, here ten minutes by the clock.
test("a ticket that waited for another's fix books the wait apart from its working time", { timeout: 20000 }, async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd: string, file: string, text: string) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", `change ${file}`);
  };
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
        const before = git(path, "rev-parse", "HEAD");
        const [kind, id] = (opts.name ?? "").split("-");
        if (kind === "impl" || kind === "repair") commit(path, `src/${kind}-${id}.ts`, `${id}\n`);
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };
  const failure = { name: "test", command: "run-tests", exitCode: 1, output: "✖ rolls over at midnight (3.1ms)\nℹ fail 1" };
  const gates: GateRun[] = [{ gates: [{ name: "test", pass: false }], failure, failures: [failure] }, { gates: [{ name: "test", pass: true }], failures: [] }];
  const fixes = createFixBoard(undefined, 10);
  // Ticket 1 is repairing the same failure, so ticket 2 waits for its ending.
  fixes.claim((await import("../src/gates.ts")).failureKey(failure), "1");
  const took = new Map<string, number>();
  const waited = new Map<string, number>();
  const lines: string[] = [];
  const log = console.log;
  const now = Date.now;
  let ahead = 0;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  Date.now = () => now() + ahead;
  try {
    const pipeline = createPipeline({
      project: {
        root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }],
        generated: [], setup: [], implement: {}, review: {}, repair: {}, changelog: true,
      } as unknown as Ctx["project"],
      tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
      runId: "2026-10-05T00:00:00.000Z",
      dryRun: false,
      repair: 1,
      testRedGate: false,
      prompts,
      overrides: new Map(),
      open,
      gate: async () => gates.shift()!,
      baseGate: async () => assert.fail("no base gate run was expected"),
      baseWentRed: () => {},
      timed: async (_issue, _phase, fn) => fn(),
      run: { ticket: () => {} },
      view: { claim: () => {} },
      host: { begin: () => {}, settle: async () => {} },
      requeuedAs: new Map(),
      results: [],
      reds: new Map(),
      fixes,
      reports: new Map(),
      notes: [],
      took,
      waited,
      keptWorktrees: [],
      tampered: new Map(),
    });
    const second = pipeline({ id: "2", title: "ticket 2", body: "" } as Parameters<typeof pipeline>[0]);
    for (let i = 0; i < 500 && !lines.some((l) => l.startsWith("#2: waiting for ")); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(lines.some((l) => l.startsWith("#2: waiting for #1's fix")), "ticket 2 never waited for ticket 1's fix");
    ahead = 10 * MIN;
    // Ticket 1's repair never landed: ticket 2 repairs on its own.
    fixes.told({ kind: "ended", id: "1", ending: { kind: "pipeline", outcome: {}, attempts: 1 } });
    assert.equal((await second).status, "green");
  } finally {
    console.log = log;
    Date.now = now;
  }
  const total = took.get("2")!;
  assert.ok(total >= 10 * MIN, `the pipeline's time holds the wait (${total} ms)`);
  assert.ok(waited.get("2")! >= 10 * MIN, `the wait is booked as one (${waited.get("2")} ms)`);
  assert.ok(total - waited.get("2")! < MIN, `its working time is what is left (${total - waited.get("2")!} ms)`);
});
