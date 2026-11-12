// One "outside the branch" verdict per run: a repair that judged its red outside the branch
// (`<verdict>outside-branch</verdict>` and a `Flaky:` line, `repairVerdict`) is recorded on the run's fix board
// (`judgedOutside`), and a later ticket red on only those tests (`outsideFor`) starts no repair pass: it ends red
// carrying the first verdict in its note. Two pipelines (`createPipeline`, src/burndown.ts) over one temp repo and
// one board, as test/fix-wait.test.ts builds them: scripted agents and gate runs; no Docker, model, gh or network.
//
//   pnpm test:file test/fix-board-outside-verdict.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { createFixBoard } = await import("../src/schedule.ts");
const { describe } = await import("../src/ledger.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type GateRun = import("../src/gates.ts").GateRun;
type Change = Parameters<ReturnType<typeof createFixBoard>["told"]>[0];

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-outside-verdict-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

// The scenarios are a few dozen git processes each (about 100 ms alone), so what a loaded machine
// stretches is process start-up: each one the harness avoids is time the test does not lose. A commit
// spawns `git maintenance run --auto` after itself unless that is off, and the commits an agent made
// are counted as they are made rather than read back with two more git calls.
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "maintenance.auto=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** How many commits each worktree has been given by `commit`. */
const made = new Map<string, number>();
const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
  made.set(cwd, (made.get(cwd) ?? 0) + 1);
};

const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const red = (output: string): GateRun => {
  const failure = { name: "test", command: "run-tests", exitCode: 1, output };
  return { gates: [{ name: "test", pass: false }], failure, failures: [failure] };
};
// node:test's own report names no file, so the red is the branch's own as far as the base check can tell:
// the pipeline never asks for a base gate run here.
const CLOCK = red("✖ rolls over at midnight (3.1ms)\nℹ fail 1");
const TWO = red("✖ rolls over at midnight (3.1ms)\n✖ parses dates (1.2ms)\nℹ fail 2");
const SAID = "Not this branch's.\n<verdict>outside-branch</verdict>\nFlaky: rolls over at midnight\n<promise>COMPLETE</promise>";
const LINE = "rolls over at midnight";

/** How the scheduler tells a ticket's end when it ended red in its pipeline. */
const failed = (id: string): Change => ({ kind: "ended", id, ending: { kind: "pipeline", outcome: {}, attempts: 1 } });

// Every test's own limit (the one that fails a scenario that hangs) is this long; a pipeline that has not
// got where the test waits for it by 50 s fails here first, and says where it stopped.
const LIMIT = 60_000;
const until = async (cond: () => boolean) => {
  for (const stop = Date.now() + 50_000; Date.now() < stop && !cond(); ) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(cond(), "the pipeline never got there");
};

// The repository every scenario starts from, built once: copying its files starts no process.
const START = join(TMP, "start");
mkdirSync(START);
git(START, "init", "-q", "-b", "main");
git(START, "config", "user.name", "Operator Example");
git(START, "config", "user.email", "operator@example.com");
git(START, "config", "commit.gpgsign", "false");
commit(START, "shared.txt", "start\n");

/** Two tickets' pipelines over one repo and one board; `gateOf` says what each ticket's gate runs return, in order. */
const harness = (gateOf: (id: string) => GateRun[]) => {
  const root = join(TMP, `repo${n++}`);
  cpSync(START, root, { recursive: true });
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const events = new Map<string, string[]>();
  const eventsOf = (id: string) => events.get(id) ?? events.set(id, []).get(id)!;
  const lines: string[] = [];
  const repairs: string[] = [];
  const gates = new Map<string, GateRun[]>();
  const agents: Record<string, (id: string, worktree: string) => string | void | Promise<string | void>> = {
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
        eventsOf(id).push(kind);
        const before = made.get(path) ?? 0;
        if (kind === "repair") repairs.push(id);
        const said = await agents[kind]?.(id, path);
        const commits = Array.from({ length: (made.get(path) ?? 0) - before }, (_, i) => ({ sha: `${path}#${before + i}` }));
        return { iterations: [], stdout: typeof said === "string" ? said : "", commits };
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
  const fixes = createFixBoard(undefined, 10);
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
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
      eventsOf(id).push("gate");
      const queue = gates.get(id) ?? gateOf(id);
      gates.set(id, queue);
      const next = queue.shift();
      assert.ok(next, `a gate run of ${id} the test did not expect`);
      return next;
    },
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
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });
  const attempt = (id: string): Promise<Outcome> => pipeline({ id, title: `ticket ${id}`, body: "" } as Parameters<typeof pipeline>[0]);
  const waiting = (id: string) => lines.some((l) => l.startsWith(`#${id}: waiting for `));
  return { agents, repairs, events: eventsOf, lines, fixes, attempt, waiting, restore: () => void (console.log = log) };
};


const judging = (h: ReturnType<typeof harness>) => {
  h.agents.repair = () => SAID;
};
const noteOf = (o: Outcome) => describe({ kind: "pipeline", outcome: o, attempts: 1 }, { base: "main", gateNames: "test" }).record?.note ?? "";

test("a later ticket red on the tests a repair judged outside its branch runs no repair pass and carries that verdict in its note", { timeout: LIMIT }, async () => {
  const h = harness((id) => (id === "1" ? [CLOCK, CLOCK] : [CLOCK]));
  try {
    judging(h);
    const first = await h.attempt("1");
    assert.equal(first.status, "gate-failed");
    assert.deepEqual(first.outside, { line: LINE, tests: ["rolls over at midnight"] });
    h.fixes.told(failed("1"));

    const second = await h.attempt("2");
    assert.deepEqual(h.repairs, ["1"], "the repair agent was never called for the second ticket");
    assert.deepEqual(h.events("2"), ["impl", "review", "gate"], "no further gate run either");
    assert.equal(second.status, "gate-failed");
    assert.deepEqual(second.outside, { line: LINE, tests: ["rolls over at midnight"], by: "1" });
    assert.ok(h.lines.includes("#2: test red on the tests #1's repair judged outside its branch - no repair pass"), h.lines.join("\n"));
    assert.match(noteOf(second), /^test red - #1's repair judged it outside this branch: rolls over at midnight$/);
    assert.match(noteOf(first), /- the repair judged it outside this branch: rolls over at midnight$/, "the judging ticket's own note is as before");
  } finally {
    h.restore();
  }
});

test("a ticket red on one more test than the verdict named still gets its repair", { timeout: LIMIT }, async () => {
  const h = harness((id) => (id === "1" ? [CLOCK, GREEN] : [TWO, GREEN]));
  try {
    judging(h);
    await h.attempt("1");
    h.fixes.told(failed("1"));
    h.agents.repair = (id, wt) => commit(wt, "src/fix.ts", `fix by ${id}\n`);
    const second = await h.attempt("2");
    assert.deepEqual(h.repairs, ["1", "2"], "the second ticket repaired as before");
    assert.equal(second.status, "green");
    assert.equal(second.outside, undefined);
  } finally {
    h.restore();
  }
});

test("a verdict on a pass that committed is not recorded, so a later ticket repairs as before", { timeout: LIMIT }, async () => {
  const h = harness((id) => (id === "1" ? [CLOCK, GREEN] : [CLOCK, GREEN]));
  try {
    h.agents.repair = (id, wt) => {
      commit(wt, `src/fix-${id}.ts`, "fix\n");
      return SAID;
    };
    await h.attempt("1");
    h.fixes.told(failed("1"));
    const second = await h.attempt("2");
    assert.deepEqual(h.repairs, ["1", "2"]);
    assert.equal(second.outside, undefined);
  } finally {
    h.restore();
  }
});

test("a verdict with no readable test id (a lint gate) is not recorded", { timeout: LIMIT }, async () => {
  const LINT = red("src/a.ts:1:1 error no-unused-vars");
  const h = harness(() => [LINT, LINT]);
  try {
    h.agents.repair = () => "<verdict>outside-branch</verdict>\nFlaky: lint is flaky\n";
    const first = await h.attempt("1");
    assert.deepEqual(first.outside, { line: "lint is flaky", tests: [] });
    h.fixes.told(failed("1"));
    h.agents.repair = () => "";
    const second = await h.attempt("2");
    assert.deepEqual(h.repairs, ["1", "2"], "the second ticket repaired: nothing was recorded");
    assert.equal(second.outside, undefined);
  } finally {
    h.restore();
  }
});

test("a ticket that went red while another's repair ran skips its own once that repair gives the verdict", { timeout: LIMIT }, async () => {
  const h = harness((id) => (id === "1" ? [CLOCK, CLOCK] : [CLOCK]));
  try {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    h.agents.repair = async () => {
      await blocked;
      return SAID;
    };
    const first = h.attempt("1");
    await until(() => h.repairs.includes("1"));
    const second = h.attempt("2");
    await until(() => h.waiting("2"));
    assert.deepEqual(h.events("2"), ["impl", "review", "gate"], "waiting for the first ticket's fix");

    release();
    assert.equal((await first).status, "gate-failed");
    h.fixes.told(failed("1"));
    const o = await second;
    assert.deepEqual(h.repairs, ["1"], "the second ticket's repair agent was not called");
    assert.equal(o.status, "gate-failed");
    assert.equal(o.outside?.by, "1");
  } finally {
    h.restore();
  }
});

test("the fix board records a verdict only with test ids, and gives it for a red whose every test it names", () => {
  const board = createFixBoard();
  board.judgedOutside("1", { line: "no ids", tests: [] });
  assert.equal(board.outsideFor(["a"]), undefined, "a verdict with no tests is not recorded");
  board.judgedOutside("2", { line: "a and b are slow", tests: ["a", "b"] });
  board.judgedOutside("3", { line: "c is slow", tests: ["c"] });
  assert.deepEqual(board.outsideFor(["a"]), { by: "2", line: "a and b are slow", tests: ["a", "b"] });
  assert.deepEqual(board.outsideFor(["b", "a"])?.by, "2");
  assert.equal(board.outsideFor(["a", "c"]), undefined, "no one verdict names both");
  assert.equal(board.outsideFor(["a", "d"]), undefined, "d is in none");
  assert.equal(board.outsideFor([]), undefined, "an empty list matches nothing");
  assert.equal(board.outsideFor(["c"])?.by, "3");
});
