// A ticket red on a test another ticket is already repairing: two pipelines (`createPipeline`,
// src/burndown.ts) over one temp repo and one fix board (`createFixBoard`, src/schedule.ts), scripted
// agents and gate runs, and the scheduler's endings told to the board as burndown's `tell` tells them.
// No Docker, model, gh or network. The second ticket waits for the first one's landing, merges the new
// base and gates again (no repair, no resolve pass) - at once, when that fix landed before its gate went
// red; if the first ticket's fix never lands, it repairs. A ticket whose branch already holds the first
// one's landing (it started after) repairs at once: a merge would bring it nothing.
//
//   pnpm exec tsx --test test/fix-wait.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merges pass process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { createFixBoard } = await import("../src/schedule.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type GateRun = import("../src/gates.ts").GateRun;
type Change = Parameters<ReturnType<typeof createFixBoard>["told"]>[0];

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-fix-wait-"));
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

/** How the scheduler tells a ticket's end: landed on the base, or ended red in its pipeline. */
const landed = (id: string): Change => ({ kind: "ended", id, ending: { kind: "landing", green: { issue: id }, landed: { kind: "merged" }, attempts: 1 } });
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
const harness = (gateOf: (id: string) => GateRun[], starved?: () => boolean) => {
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
  const gates = new Map<string, GateRun[]>();
  // A ticket's next gate run, held until the test releases it.
  const holds = new Map<string, Promise<void>>();
  const hold = (id: string) => {
    let release!: () => void;
    holds.set(id, new Promise<void>((resolve) => (release = resolve)));
    return release;
  };
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
        eventsOf(id).push(kind);
        const before = made.get(path) ?? 0;
        agents[kind]?.(id, path);
        const commits = Array.from({ length: (made.get(path) ?? 0) - before }, (_, i) => ({ sha: `${path}#${before + i}` }));
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
  // The commit each landing put on the base: burndown's landing record, which the board reads as a ticket ends.
  const landings = new Map<string, string>();
  const fixes = createFixBoard(starved, 10, (id) => landings.get(id));
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
      const held = holds.get(id);
      holds.delete(id);
      await held;
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
  /** The landing worker merges the ticket's branch into the base, as `landOne` does. */
  const land = (id: string) => {
    git(root, "merge", "--no-ff", "-q", "-m", `Merge agent/issue-${id} (closes #${id})`, `agent/issue-${id}`);
    landings.set(id, git(root, "rev-parse", "HEAD"));
  };
  /** Another ticket's landing: the base moves, so a merge of it into a branch would make a new commit. */
  const moveBase = (file: string) => commit(root, file, "landed meanwhile\n");
  const has = (branch: string, file: string) => spawnSync("git", ["cat-file", "-e", `${branch}:${file}`], { cwd: root }).status === 0;
  const waiting = (id: string) => lines.some((l) => l.startsWith(`#${id}: waiting for `));
  return { agents, events: eventsOf, lines, fixes, attempt, land, moveBase, has, waiting, hold, restore: () => void (console.log = log) };
};

const fixing = (h: ReturnType<typeof harness>) => {
  h.agents.repair = (id, wt) => commit(wt, "src/fix.ts", `fix by ${id}\n`);
};

test("two tickets red on the same test start one repair, and the second gates green after the first lands, with no resolve pass", { timeout: LIMIT }, async () => {
  const h = harness(() => [CLOCK, GREEN]);
  try {
    fixing(h);
    const first = await h.attempt("1");
    assert.equal(first.status, "green");
    assert.deepEqual(h.events("1"), ["impl", "review", "gate", "repair", "gate", "review"]);

    const second = h.attempt("2");
    await until(() => h.waiting("2"));
    assert.deepEqual(h.events("2"), ["impl", "review", "gate"], "no repair while the first one's fix is yet to land");
    assert.deepEqual(h.lines.filter((l) => l.includes("waiting for")), ["#2: waiting for #1's fix to rolls over at midnight"]);

    h.land("1");
    h.fixes.told(landed("1"));
    const o = await second;
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 0);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "gate"], "gated again on the new base: no repair, no resolve, no second review");
    assert.ok(h.has("agent/issue-2", "src/fix.ts"), "the first one's fix reached the branch by the base merge");
    assert.ok(h.lines.some((l) => l.startsWith("#2: #1 landed - merged main into its branch")));
  } finally {
    h.restore();
  }
});

test("a ticket whose first one's repair fails then starts its own repair", { timeout: LIMIT }, async () => {
  const h = harness((id) => (id === "1" ? [CLOCK] : [CLOCK, GREEN]));
  try {
    h.agents.repair = (id, wt) => {
      if (id === "1") throw new Error("agent exited");
      commit(wt, "src/fix.ts", `fix by ${id}\n`);
    };
    const first = await h.attempt("1");
    assert.equal(first.status, "gate-failed");

    const second = h.attempt("2");
    await until(() => h.waiting("2"));
    assert.deepEqual(h.events("2"), ["impl", "review", "gate"]);

    h.fixes.told(failed("1"));
    const o = await second;
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 1);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "repair", "gate", "review"]);
  } finally {
    h.restore();
  }
});

test("a ticket sent back at landing frees the ones waiting for its fix, which repair on their own", { timeout: LIMIT }, async () => {
  const h = harness(() => [CLOCK, GREEN]);
  try {
    fixing(h);
    await h.attempt("1");
    const second = h.attempt("2");
    await until(() => h.waiting("2"));
    // Its landing collided: its second attempt may be queued behind the very pipelines that wait for it.
    h.fixes.told({ kind: "requeued", id: "1", again: { kind: "conflict", with: ["3"] } });
    const o = await second;
    assert.equal(o.repairs, 1);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "repair", "gate", "review"]);
  } finally {
    h.restore();
  }
});

test("a ticket still red after the first one's fix landed repairs, and does not wait a second time", { timeout: LIMIT }, async () => {
  const h = harness((id) => (id === "1" ? [CLOCK, GREEN] : [CLOCK, CLOCK, GREEN]));
  try {
    fixing(h);
    await h.attempt("1");
    const second = h.attempt("2");
    await until(() => h.waiting("2"));
    h.land("1");
    h.fixes.told(landed("1"));
    const o = await second;
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 1);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "gate", "repair", "gate", "review"]);
    assert.equal(h.lines.filter((l) => l.includes("waiting for")).length, 1);
  } finally {
    h.restore();
  }
});

test("a ticket that repaired before it waited has those repair commits reviewed once it gates green on the merged base", { timeout: LIMIT }, async () => {
  const TYPES = red("src/ticket-2.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.");
  const h = harness((id) => (id === "1" ? [CLOCK, GREEN] : [TYPES, CLOCK, GREEN]));
  try {
    h.agents.repair = (id, wt) => commit(wt, id === "1" ? "src/fix.ts" : "src/types.ts", `fix by ${id}\n`);
    await h.attempt("1");
    const second = h.attempt("2");
    await until(() => h.waiting("2"));
    h.land("1");
    h.fixes.told(landed("1"));
    const o = await second;
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 1);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "repair", "gate", "gate", "review"], "its own repair is reviewed, though the merge came after it");
  } finally {
    h.restore();
  }
});

test("a landing left waiting for a sandbox slot frees the tickets waiting for a fix, which repair on their own", { timeout: LIMIT }, async () => {
  // The waiter holds its slot; the landing it waits for may need that very slot (the run's share shrank).
  let landingWaits = false;
  const h = harness(() => [CLOCK, GREEN], () => landingWaits);
  try {
    fixing(h);
    await h.attempt("1");
    const second = h.attempt("2");
    await until(() => h.waiting("2"));
    landingWaits = true;
    const o = await second;
    assert.equal(o.repairs, 1);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "repair", "gate", "review"]);
  } finally {
    h.restore();
  }
});

test("a ticket never waits on one that waits on it", { timeout: LIMIT }, async () => {
  const board = createFixBoard();
  board.claim("a", "1");
  board.claim("b", "2");
  const wait = board.wait("1", board.fixing("b", "1")!.by);
  // 1 waits for 2's fix to b; 2 is now red on a, which 1 is repairing: it repairs, as waiting would end nowhere.
  assert.equal(board.fixing("a", "2"), undefined);
  board.told(failed("2"));
  assert.equal(await wait, false);
});

test("a ticket red on a test whose fix landed just before its gate finished merges the base and gates again, starting no repair", { timeout: LIMIT }, async () => {
  const h = harness(() => [CLOCK, GREEN]);
  try {
    fixing(h);
    // 2's branch is cut before 1 lands; its first gate run finishes only once 1's fix is on the base.
    const release = h.hold("2");
    const second = h.attempt("2");
    await until(() => h.events("2").includes("gate"));
    const first = await h.attempt("1");
    assert.equal(first.status, "green");
    h.land("1");
    h.fixes.told(landed("1"));
    assert.ok(!h.has("agent/issue-2", "src/fix.ts"), "the branch was cut before the fix landed");
    release();
    const o = await second;
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 0);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "gate"]);
    assert.ok(h.has("agent/issue-2", "src/fix.ts"), "the landed fix reached the branch by the base merge");
    assert.ok(!h.waiting("2"), "nothing to wait for: the fix had landed");
    assert.ok(h.lines.some((l) => l.startsWith("#2: #1 landed - merged main into its branch")));
  } finally {
    h.restore();
  }
});

test("a ticket cut after the fix landed and still red on that test repairs once, without a wait", { timeout: LIMIT }, async () => {
  const h = harness(() => [CLOCK, GREEN]);
  try {
    fixing(h);
    await h.attempt("1");
    h.land("1");
    h.fixes.told(landed("1"));
    const o = await h.attempt("2");
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 1);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "repair", "gate", "review"]);
    assert.ok(!h.waiting("2"));
    assert.ok(!h.lines.some((l) => l.startsWith("#2: #1 landed")), "the merge moved nothing");
  } finally {
    h.restore();
  }
});

test("a ticket cut after the fix landed, with the base moved since, repairs at once instead of merging and gating the same red again", { timeout: 20000 }, async () => {
  const h = harness(() => [CLOCK, GREEN]);
  try {
    fixing(h);
    const first = await h.attempt("1");
    assert.equal(first.status, "green");
    h.land("1");
    h.fixes.told(landed("1"));
    // 2's branch is cut after 1's landing, so it holds the fix; its gate run goes red only once another landing moved the base.
    const release = h.hold("2");
    const second = h.attempt("2");
    await until(() => h.events("2").includes("gate"));
    h.moveBase("src/other.ts");
    release();
    const o = await second;
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 1);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "repair", "gate", "review"], "its red is its own: no merge, no second gate run before the repair");
    assert.ok(!h.waiting("2"));
    assert.ok(!h.lines.some((l) => l.startsWith("#2: #1 landed")), "no merge of the moved base was made");
    assert.ok(!h.has("agent/issue-2", "src/other.ts"), "the base was never merged into the branch");
  } finally {
    h.restore();
  }
});

test("a ticket cut before the fix landed, with the base moved after it, still merges the fix and gates again, starting no repair", { timeout: 20000 }, async () => {
  const h = harness(() => [CLOCK, GREEN]);
  try {
    fixing(h);
    const release = h.hold("2");
    const second = h.attempt("2");
    await until(() => h.events("2").includes("gate"));
    const first = await h.attempt("1");
    assert.equal(first.status, "green");
    h.land("1");
    h.fixes.told(landed("1"));
    h.moveBase("src/other.ts");
    release();
    const o = await second;
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 0);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "gate"]);
    assert.ok(h.has("agent/issue-2", "src/fix.ts"), "the landed fix reached the branch by the base merge");
    assert.ok(h.has("agent/issue-2", "src/other.ts"), "with the rest of the moved base");
    assert.ok(h.lines.some((l) => l.startsWith("#2: #1 landed - merged main into its branch")));
  } finally {
    h.restore();
  }
});

for (const [how, ending] of [
  ["stopped", { kind: "stopped", cause: undefined, finished: true, green: { issue: "1" } }],
  ["crashed", { kind: "crashed", error: new Error("land port threw"), attempts: 1, green: { issue: "1" } }],
] as const) {
  test(`a ticket waiting for a fix whose ticket ${how} repairs on its own`, { timeout: LIMIT }, async () => {
    const h = harness(() => [CLOCK, GREEN]);
    try {
      fixing(h);
      await h.attempt("1");
      const second = h.attempt("2");
      await until(() => h.waiting("2"));
      h.fixes.told({ kind: "ended", id: "1", ending } as Change);
      const o = await second;
      assert.equal(o.status, "green");
      assert.equal(o.repairs, 1);
      assert.deepEqual(h.events("2"), ["impl", "review", "gate", "repair", "gate", "review"]);
    } finally {
      h.restore();
    }
  });
}

test("a fixer sent back at landing that lands its carried branch later still counts as the fix: a ticket red on that test merges the base, starting no repair", { timeout: LIMIT }, async () => {
  const h = harness(() => [CLOCK, GREEN]);
  try {
    fixing(h);
    // 2's branch is cut before 1 lands; its first gate run finishes only once 1's fix is on the base.
    const release = h.hold("2");
    const second = h.attempt("2");
    await until(() => h.events("2").includes("gate"));
    const first = await h.attempt("1");
    assert.equal(first.status, "green");
    // Its landing collided; its second attempt lands the carried green branch, with no repair pass to claim the test again.
    h.fixes.told({ kind: "requeued", id: "1", again: { kind: "conflict", with: ["3"] } });
    h.land("1");
    h.fixes.told(landed("1"));
    release();
    const o = await second;
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 0);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "gate"]);
    assert.ok(h.has("agent/issue-2", "src/fix.ts"), "the landed fix reached the branch by the base merge");
    assert.ok(!h.waiting("2"), "nothing to wait for: the fix had landed");
    assert.ok(h.lines.some((l) => l.startsWith("#2: #1 landed - merged main into its branch")));
  } finally {
    h.restore();
  }
});

test("a fixer sent back at landing that then fails leaves no fix behind: a ticket red on that test repairs", { timeout: LIMIT }, async () => {
  const h = harness(() => [CLOCK, GREEN]);
  try {
    fixing(h);
    await h.attempt("1");
    h.fixes.told({ kind: "requeued", id: "1", again: { kind: "conflict", with: ["3"] } });
    h.fixes.told(failed("1"));
    const o = await h.attempt("2");
    assert.equal(o.status, "green");
    assert.equal(o.repairs, 1);
    assert.deepEqual(h.events("2"), ["impl", "review", "gate", "repair", "gate", "review"]);
    assert.ok(!h.waiting("2"));
  } finally {
    h.restore();
  }
});
