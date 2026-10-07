// A branch that no longer merges onto the base (another ticket landed over the same lines) skips the
// rest of its pipeline: checked on the host after implement, before review, and again before the gates.
// It is never pushed on as green: the scheduler's requeue-once rule sends it back to resolve the merge,
// and a second conflict after the requeue is final unless a landing after its resolve began caused it,
// as for a conflict at landing. A conflict only in generated files goes on as before. The pipeline
// (`createPipeline`, src/burndown.ts) runs over its faked ports - a temp repo, a host worktree as its
// sandbox, scripted agents and gate runs - and the scheduler (`createSchedule`) runs it with a fake
// landing that commits to the base. No Docker, model, gh or network.
//
//   node --test test/pipeline-conflict-before-landing.test.ts

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
const { attempted, createPipeline } = await import("../src/burndown.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type GateRun = import("../src/gates.ts").GateRun;
type Landed = import("../src/landing.ts").Landed;
type Change = import("../src/schedule.ts").Change<Outcome, Outcome>;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-conflict-before-"));
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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 1000 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};

const ID = "7";
const BRANCH = `agent/issue-${ID}`;
const issue = (id: string) => ({ id, title: `ticket ${id}`, body: "" }) as Issue;
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/** What an agent does in the sandbox's worktree, by its pass: `impl`, `review`, `repair` or `resolve`. */
type Agent = (worktree: string) => Promise<string | void> | string | void;

/**
 * A project in a temp repo and a pipeline over it, every port faked. `events` is each agent pass and gate
 * run of the attempt in order. `land(id, file, text)` is another ticket landing on main, recorded in the
 * run's landings as burndown's landing worker records it.
 */
const harness = (o: { generated?: { paths: string[]; regen: string[] }[] } = {}) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n", "start");
  commit(root, "out.css", "start\n", "generated");
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}} {{REVIEW_BASE}} {{REPAIR_BASE}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const events: string[] = [];
  const agents: Record<string, Agent> = {};
  const gates: GateRun[] = [];
  const landed = new Map<string, { files: string[]; commit: string }>();
  const requeuedAs = new Map<string, string>();

  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const box = {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const kind = (opts.name ?? "").split("-")[0];
        events.push(kind);
        const before = git(path, "rev-parse", "HEAD");
        const stdout = (await agents[kind]?.(path)) ?? "";
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
    gates: [{ name: "test", command: "run-tests" }],
    generated: o.generated ?? [],
    setup: [],
    implement: {},
    review: {},
    repair: {},
  } as unknown as Ctx["project"];
  const results: PromiseSettledResult<Outcome>[] = [];

  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-07T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      events.push("gate");
      const next = gates.shift();
      assert.ok(next, "a gate run the test did not expect");
      return next;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, _phase, fn) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs,
    results,
    reds: new Map(),
    landed,
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });

  /** Another ticket lands on main over `file`, recorded as the landing worker records it. */
  const land = (id: string, file: string, text: string) => {
    const before = git(root, "rev-parse", "main");
    commit(root, file, text, `Merge agent/issue-${id} (closes #${id})`);
    const after = git(root, "rev-parse", "main");
    landed.set(id, { commit: after, files: git(root, "diff", "--name-only", before, after).split("\n").filter(Boolean) });
  };

  /** One attempt of ticket 7, its result kept as burndown's attempt keeps it. */
  const attempt = async () => {
    events.length = 0;
    const { result, lines } = await quietly(() => pipeline(issue(ID)));
    results.splice(0, results.length, { status: "fulfilled", value: result });
    return { o: result, lines };
  };

  /**
   * Tickets 1 and 7 (and 3, when `third` lands) in a schedule, with ticket 7's real pipeline: what each attempt of 7 did
   * (`passes`, by attempt), the scheduler's changes, and the endings. The others are green at once and land through the
   * landing port, which commits their change to main when `landWhen` says so.
   */
  const schedule = async (s: { landWhen: Record<string, () => boolean>; changes: Record<string, [string, string]> }) => {
    const passes: string[][] = [];
    const told: Change[] = [];
    const tickets = Object.keys(s.landWhen).map((id) => ({ id }));
    const { result } = await quietly(() =>
      createSchedule<{ id: string }, Outcome, Outcome>({ tickets: [...tickets, { id: ID }] }).run({
        workers: tickets.length + 1,
        attempt: async (t, at) => {
          if (t.id !== ID) {
            await until(s.landWhen[t.id], `${t.id}'s turn to land`);
            return { kind: "green", green: { issue: t.id, branch: `agent/issue-${t.id}`, status: "green", commits: 1, reviewCommits: 0, repairs: 0, gates: [] } };
          }
          events.length = 0;
          const value = await pipeline(issue(ID)).then(
            (v) => ({ status: "fulfilled", value: v }) as const,
            (reason: unknown) => ({ status: "rejected", reason }) as const,
          );
          passes[at.n - 1] = [...events];
          results.splice(0, results.length, value);
          return attempted(ID, value);
        },
        land: async (g): Promise<Landed> => {
          if (g.issue !== ID) {
            const [file, text] = s.changes[g.issue];
            land(g.issue, file, text);
          }
          return { kind: "merged" };
        },
        host: { check: async () => {}, failed: undefined },
        tell: (c) => {
          told.push(c);
          // The ledger's part: the line a requeued ticket's second attempt carries.
          if (c.kind === "requeued") requeuedAs.set(c.id, `requeued after conflict with ${c.again.with.map((w) => `#${w}`).join(", ")}`);
        },
      }),
    );
    return { passes, told, endings: result.endings };
  };
  return { root, agents, gates, events, landed, land, attempt, schedule };
};

/** An implementer that commits `file`. */
const implementing = (file: string, text: string) => (wt: string) => void commit(wt, file, text);
/** A pass that resolves the merge in progress with `text` in `file` and commits it. */
const resolving = (file: string, text: string) => (wt: string) => {
  write(wt, file, text);
  git(wt, "add", file);
  git(wt, "commit", "-q", "--no-edit");
};

test("a branch that conflicts before its review starts neither review nor gates, and is no green", async () => {
  const h = harness();
  h.agents.impl = (wt) => {
    commit(wt, "shared.txt", "seven\n");
    // Ticket 1 lands over the same line while the implementer works.
    h.land("1", "shared.txt", "one\n");
  };
  const { o, lines } = await h.attempt();
  assert.deepEqual(h.events, ["impl"]);
  assert.equal(o.status, "conflict");
  assert.deepEqual(o.conflict, { files: ["shared.txt"], with: ["1"] });
  assert.equal(o.commits, 1);
  assert.ok(lines.includes(`#7: ${BRANCH} no longer merges onto main (with #1: shared.txt) - its review and gates are skipped.`), lines.join("\n"));
  // What the scheduler is handed: a conflict for its requeue-once rule, not a green for the landing worker.
  const report = attempted(ID, { status: "fulfilled", value: o });
  assert.equal(report.kind, "conflict");
  assert.deepEqual(report.kind === "conflict" && report.conflict, { files: ["shared.txt"], with: ["1"] });
});

test("a branch that conflicts only before its gates is reviewed, then skips the gates", async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.agents.review = () => void h.land("1", "shared.txt", "one\n");
  const { o, lines } = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review"]);
  assert.equal(o.status, "conflict");
  assert.deepEqual(o.conflict, { files: ["shared.txt"], with: ["1"] });
  assert.ok(lines.includes(`#7: ${BRANCH} no longer merges onto main (with #1: shared.txt) - its gates are skipped.`), lines.join("\n"));
});

test("a landing on other lines, or one only in generated files, changes nothing: review and gates run, and the branch is green", async () => {
  const h = harness({ generated: [{ paths: ["out.css"], regen: ["make css"] }] });
  h.agents.impl = (wt) => {
    commit(wt, "shared.txt", "seven\n");
    commit(wt, "out.css", "seven\n");
    h.land("1", "other.txt", "one\n");
  };
  h.agents.review = () => void h.land("2", "out.css", "two\n");
  h.gates.push(GREEN);
  const { o } = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  assert.equal(o.status, "green");
});

test("a conflict before review takes the requeue-once path: sent back, the implementer resolves the merge and it lands", async () => {
  const h = harness();
  let implemented = false;
  h.agents.impl = async (wt) => {
    if (implemented) return resolving("shared.txt", "one\nseven\n")(wt);
    commit(wt, "shared.txt", "seven\n");
    implemented = true;
    await until(() => h.landed.has("1"), "1 to land");
  };
  h.agents.review = () => {};
  h.gates.push(GREEN);
  const { passes, told, endings } = await h.schedule({ landWhen: { 1: () => implemented }, changes: { 1: ["shared.txt", "one\n"] } });
  assert.deepEqual(passes, [["impl"], ["impl", "review", "gate"]]);
  assert.deepEqual(told.filter((c) => c.kind === "requeued"), [{ kind: "requeued", id: ID, again: { kind: "conflict", with: ["1"] } }]);
  const seven = endings.get(ID);
  assert.equal(seven?.kind, "landing");
  assert.equal(seven?.kind === "landing" && seven.landed.kind, "merged");
  assert.equal(seven?.kind === "landing" && seven.attempts, 2);
  assert.deepEqual(seven?.kind === "landing" && seven.again, { kind: "conflict", with: ["1"] });
});

test("a conflict before the gates takes the requeue-once path: sent back, a resolver resolves the merge, a narrow review reads it and it lands", async () => {
  const h = harness();
  let reviewed = false;
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.agents.review = async () => {
    if (reviewed) return;
    reviewed = true;
    await until(() => h.landed.has("1"), "1 to land");
  };
  h.agents.resolve = resolving("shared.txt", "one\nseven\n");
  h.gates.push(GREEN);
  const { passes, told, endings } = await h.schedule({ landWhen: { 1: () => reviewed }, changes: { 1: ["shared.txt", "one\n"] } });
  // Reviewed on the first attempt, so the second needs no implementer: the resolve, its narrow review, then the gates.
  assert.deepEqual(passes, [["impl", "review"], ["resolve", "review", "gate"]]);
  assert.deepEqual(told.filter((c) => c.kind === "requeued"), [{ kind: "requeued", id: ID, again: { kind: "conflict", with: ["1"] } }]);
  const seven = endings.get(ID);
  assert.equal(seven?.kind === "landing" && seven.landed.kind, "merged");
  assert.equal(seven?.kind === "landing" && seven.attempts, 2);
});

test("a second conflict after the requeue is final: the ticket ends as a conflict naming both attempts", async () => {
  const h = harness();
  let implemented = false;
  // The second implementer leaves the merge unresolved: the branch still does not hold ticket 1's landing.
  h.agents.impl = async (wt) => {
    if (implemented) return;
    commit(wt, "shared.txt", "seven\n");
    implemented = true;
    await until(() => h.landed.has("1"), "1 to land");
  };
  const { passes, told, endings } = await h.schedule({ landWhen: { 1: () => implemented }, changes: { 1: ["shared.txt", "one\n"] } });
  assert.deepEqual(passes, [["impl"], ["impl"]]);
  assert.equal(told.filter((c) => c.kind === "requeued").length, 1);
  const seven = endings.get(ID);
  assert.equal(seven?.kind, "conflict");
  assert.deepEqual(seven?.kind === "conflict" && seven.conflict, { files: ["shared.txt"], with: ["1"] });
  assert.deepEqual(seven?.kind === "conflict" && seven.again, { kind: "conflict", with: ["1"] });
  assert.equal(seven?.kind === "conflict" && seven.attempts, 2);
});

test("a second conflict caused by a landing after the resolve began sends the ticket back again", async () => {
  const h = harness();
  let attempts = 0;
  h.agents.impl = async (wt) => {
    attempts++;
    if (attempts === 1) {
      commit(wt, "shared.txt", "seven\n");
      await until(() => h.landed.has("1"), "1 to land");
    } else if (attempts === 2) {
      resolving("shared.txt", "one\nseven\n")(wt);
      // Ticket 3 lands over the same line while the resolve runs: no fault of the resolve.
      await until(() => h.landed.has("3"), "3 to land");
    } else resolving("shared.txt", "three\nseven\n")(wt);
  };
  h.agents.review = () => {};
  h.gates.push(GREEN);
  const { passes, told, endings } = await h.schedule({
    landWhen: { 1: () => attempts >= 1, 3: () => attempts >= 2 },
    changes: { 1: ["shared.txt", "one\n"], 3: ["shared.txt", "three\n"] },
  });
  assert.deepEqual(passes, [["impl"], ["impl"], ["impl", "review", "gate"]]);
  assert.deepEqual(
    told.flatMap((c) => (c.kind === "requeued" ? [c.again.with] : [])),
    [["1"], ["3"]],
  );
  const seven = endings.get(ID);
  assert.equal(seven?.kind === "landing" && seven.landed.kind, "merged");
  assert.equal(seven?.kind === "landing" && seven.attempts, 3);
});
