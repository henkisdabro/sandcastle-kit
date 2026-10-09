// A ticket waiting for another ticket's fix, when a person pauses the run: two pipelines (`createPipeline`,
// src/burndown.ts) under one scheduler (`createSchedule`, src/schedule.ts) and one fix board, over a temp
// repo with a worktree for each sandbox and scripted agents and gate runs. The fixer parks at its
// review (it cannot land while paused); the waiter stops waiting, parks too (its sandbox closes) and the
// run's demand drops to 0. On the resume the fixer lands, and the waiter merges its fix and gates again,
// with no repair of its own. No Docker, model, gh or network.
//
//   pnpm test:file test/fix-wait-pause.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { useNoDocker } from "./no-docker.ts";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
useNoDocker();
const { createPipeline } = await import("../src/burndown.ts");
const { createFixBoard, createSchedule } = await import("../src/schedule.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;
type G = { issue: string };
type Change = import("../src/schedule.ts").Change<G, string, string>;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-fix-wait-pause-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "maintenance.auto=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 2000 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const CLOCK_RED = (() => {
  const failure = { name: "test", command: "run-tests", exitCode: 1, output: "✖ rolls over at midnight (3.1ms)\nℹ fail 1" };
  return { gates: [{ name: "test", pass: false }], failure, failures: [failure] } as GateRun;
})();

test("a ticket waiting for another's fix parks when the run is paused, and on the resume merges the fix with no repair of its own", { timeout: 60_000 }, async () => {
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

  let since: number | undefined;
  const source = { read: () => (since === undefined ? undefined : { since }), pollMs: 5 };
  const events = new Map<string, string[]>();
  const eventsOf = (id: string) => events.get(id) ?? events.set(id, []).get(id)!;
  const notes = new Map<string, string[]>();
  const states: string[] = [];
  const closed: string[] = [];
  const landings = new Map<string, string>();
  const gates = new Map<string, GateRun[]>([["1", [CLOCK_RED, GREEN]], ["2", [CLOCK_RED, GREEN]]]);
  // The waiter's first gate run is held until the fixer is repairing, so it finds the claim on the board.
  let fixerRepairing!: () => void;
  const repairing = new Promise<void>((resolve) => (fixerRepairing = resolve));
  const waiting = () => (notes.get("2") ?? []).some((l) => l.startsWith("waiting for "));

  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const [kind, id] = (opts.name ?? "").split("-");
        eventsOf(id).push(kind);
        const before = git(path, "rev-parse", "HEAD");
        if (kind === "impl") commit(path, `src/ticket-${id}.ts`, `${id}\n`);
        if (kind === "repair") {
          fixerRepairing();
          await until(waiting, "ticket 2 to wait for the fix");
          // The person pauses the run while the fixer's repair pass runs: it ends, and its review does not begin.
          since = 1_790_000_000;
          commit(path, "src/fix.ts", `fix by ${id}\n`);
        }
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        closed.push(path);
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };

  const fixes = createFixBoard(undefined, 5, (id) => landings.get(id));
  const pipeline = createPipeline({
    project: { root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }], generated: [], setup: [], implement: {}, review: {}, repair: {}, changelog: true } as unknown as Ctx["project"],
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-05T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async (_box, id) => {
      eventsOf(id).push("gate");
      if (id === "2" && gates.get("2")!.length === 2) await repairing;
      const next = gates.get(id)!.shift();
      assert.ok(next, `a gate run of ${id} the test did not expect`);
      return next;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, _phase, fn) => fn(),
    run: {
      ticket: (id, fields) => {
        if (fields.note) notes.set(id, [...(notes.get(id) ?? []), fields.note]);
        if (fields.state === "paused") states.push(id);
      },
    },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    fixes,
    reports: new Map(),
    notes: [],
    took: new Map(),
    waited: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });

  const told: Change[] = [];
  const demands = () => told.flatMap((c) => (c.kind === "demand" ? [c.n] : []));
  const issues = [{ id: "1", title: "one", body: "" }, { id: "2", title: "two", body: "" }] as Parameters<typeof pipeline>[0][];
  const outcomes = new Map<string, string>();
  const done = quietly(() =>
    createSchedule<(typeof issues)[number], G, string, string>({ tickets: issues }).run({
      workers: 2,
      concurrency: 2,
      pause: source,
      attempt: async (issue, at) => {
        const outcome = await pipeline(issue, at);
        outcomes.set(issue.id, outcome.status);
        return outcome.status === "green" ? { kind: "green", green: { issue: issue.id } } : { kind: "pipeline", outcome: outcome.status };
      },
      land: async (g) => {
        git(root, "merge", "--no-ff", "-q", "-m", `Merge agent/issue-${g.issue} (closes #${g.issue})`, `agent/issue-${g.issue}`);
        landings.set(g.issue, git(root, "rev-parse", "HEAD"));
        return { kind: "merged" } as const;
      },
      host: { check: async () => {}, failed: undefined },
      tell: (c) => {
        fixes.told(c);
        told.push(c);
      },
    }),
  );

  // Both parked: the fixer before its review after the repair, the waiter before it would repair on its own.
  await until(() => states.includes("1") && states.includes("2"), "both tickets to park");
  // A ticket says it is paused before its container is stopped and its sandbox closed.
  await until(() => closed.length === 2, "both sandboxes to close, the waiter's with the fixer's");
  assert.equal(demands().at(-1), 0, "a paused run with both tickets parked asks for no sandbox slot");
  await sleep(60);
  assert.deepEqual(eventsOf("2"), ["impl", "review", "gate"], "the waiter started no repair pass during the pause");
  assert.equal(landings.size, 0);
  const lastPaused = told.filter((c) => c.kind === "paused").at(-1);
  assert.deepEqual(lastPaused?.kind === "paused" ? lastPaused.finishing : undefined, [], "nothing is in flight");

  since = undefined;
  await done;
  assert.deepEqual([...outcomes], [["1", "green"], ["2", "green"]]);
  assert.deepEqual(eventsOf("2"), ["impl", "review", "gate", "gate"], "after the fixer landed, the waiter gated again: no repair, no second review");
  assert.equal(git(root, "show", "agent/issue-2:src/fix.ts"), "fix by 1", "the fixer's fix reached the waiter's branch by the base merge");
});
