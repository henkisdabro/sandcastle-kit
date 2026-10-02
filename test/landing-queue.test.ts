// The in-run landing worker (src/landing.ts, src/schedule.ts): pipelines push a green outcome as
// theirs ends, one worker lands them in arrival order and moves the run's expected base with its
// own writes. Fake pipelines, temp repos, a fake tracker and a host worktree for the sandbox: no
// Docker, no gh, no network.
//
//   pnpm exec tsx --test test/landing-queue.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createHostGit, landingWork, landOne, pipelineWorkers } = await import("../src/landing.ts");
const { disableHostGitGc, gitFingerprint } = await import("../src/guard.ts");
const { notLandedComment } = await import("../src/burndown.ts");
const { createLanding, createQueue, createStopState } = await import("../src/schedule.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Landed = import("../src/landing.ts").Landed;
type Waiting = import("../src/landing.ts").Waiting;
type StopState = import("../src/schedule.ts").StopState;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-queue-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};
// main holds shared.txt; each branch is cut from that start and changes the files it is given.
const makeRepo = (branches: Record<string, Record<string, string>>) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "shared.txt", "start\n", "start");
  for (const [id, files] of Object.entries(branches)) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    for (const [file, text] of Object.entries(files)) commitFile(root, file, text, `work on ${id}`);
    git(root, "checkout", "-q", "main");
  }
  return root;
};

const outcome = (root: string, id: string, extra: Record<string, unknown> = {}): Waiting => ({
  issue: id,
  branch: `agent/issue-${id}`,
  status: "green",
  commits: 1,
  repairs: 0,
  head: git(root, "rev-parse", `agent/issue-${id}`),
  ...extra,
});

// The sandbox a merge that is not a fast-forward is made and gated in: a host worktree.
// execGate wraps commands in `timeout -k n n`, which macOS lacks.
const opener = (root: string): Ctx["opener"] => async (branch) => {
  const path = join(TMP, `wt${n++}`);
  git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  return {
    worktreePath: path,
    exec: async (cmd) => {
      const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
    close: async () => git(root, "worktree", "remove", "--force", path),
  };
};

const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const failure = { name: "test", command: "test", exitCode: 1, output: "FAIL: a.txt and b.txt cannot both exist" };
const RED: GateRun = { gates: [{ name: "test", pass: false }], failure, failures: [failure] };

type Over = { land?: "merge" | "squash"; dryRun?: boolean; gate?: Ctx["gate"] };
const harness = (root: string, over: Over = {}) => {
  const calls: string[] = [];
  const history: Record<string, string[]> = {};
  const states: Record<string, { state?: string; note?: string | null }> = {};
  const tracker = {
    ref: (id: string) => `#${id}`,
    close: (id: string) => void calls.push(`close ${id}`),
    comment: (id: string) => void calls.push(`comment ${id}`),
    hold: (id: string) => void calls.push(`hold ${id}`),
  };
  const project = { root, name: "fixture", baseBranch: "main", land: over.land ?? "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const host = createHostGit(project, gitFingerprint(project));
  const ctx: Ctx = {
    project,
    tracker: tracker as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: {
      ticket: (id, fields) => {
        states[id] = { ...states[id], ...fields };
        if (typeof fields.state === "string") (history[id] ??= []).push(fields.state);
      },
    },
    dryRun: over.dryRun ?? false,
    opener: opener(root),
    withdrawal: () => undefined,
    host,
    gate: over.gate ?? (async () => GREEN),
    landed: new Map(),
  };
  const settled: { issue: string; landed: Landed }[] = [];
  const stopped: string[] = [];
  const stop = createStopState(host);
  const landing = createLanding(landingWork(ctx), stop, {
    settled: (o, landed) => void settled.push({ issue: o.issue, landed }),
    stopped: (o) => void stopped.push(o.issue),
  });
  return { ctx, host, stop, landing, calls, history, states, settled, stopped };
};

// The run's headline stop as "<kind>: <error>": a `.git` check or a refused write.
const why = (stop: StopState) => {
  const c = stop.headline;
  return c && "error" in c ? `${c.kind}: ${String(c.error)}` : c?.kind;
};

// Fake pipelines: each ends after `ms`, makes the check a real pipeline makes once its sandbox is
// closed, and pushes its green outcome. Landing closes once they are all done.
const runPipelines = async (root: string, h: ReturnType<typeof harness>, ends: Record<string, number>, extra: Record<string, Record<string, unknown>> = {}) => {
  const finished = new Set<string>();
  const seen: { issue: string; finishedThen: string[] }[] = [];
  const done = Promise.all(
    Object.entries(ends).map(async ([id, ms]) => {
      await sleep(ms);
      await h.host.check(`after #${id}`);
      finished.add(id);
      h.landing.push(outcome(root, id, extra[id]));
    }),
  ).then(() => h.landing.close());
  // What was still running as each ticket settled, for "while others still run".
  const worker = h.landing.run();
  const poll = setInterval(() => {
    for (const s of h.settled) if (!seen.some((x) => x.issue === s.issue)) seen.push({ issue: s.issue, finishedThen: [...finished] });
  }, 1);
  try {
    await Promise.all([done, worker]);
  } finally {
    clearInterval(poll);
  }
  return { seen };
};

const mergeOrder = (root: string) =>
  git(root, "log", "--first-parent", "--reverse", "--format=%s", "main")
    .split("\n")
    .flatMap((s) => /^Merge agent\/issue-(\d+) /.exec(s)?.[1] ?? []);

test("three tickets finishing at different times land in arrival order, each while others still run", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" }, 3: { "c.txt": "c\n" } });
  const h = harness(root);
  const { seen } = await runPipelines(root, h, { 1: 240, 2: 20, 3: 130 });
  assert.deepEqual(mergeOrder(root), ["2", "3", "1"]);
  assert.deepEqual(h.settled.map((s) => s.landed.kind), ["merged", "merged", "merged"]);
  // Landing 2 and 3 happened before the last pipeline ended.
  assert.deepEqual(seen.find((s) => s.issue === "2")?.finishedThen.includes("1"), false);
  assert.deepEqual(h.history["2"], ["landing", "merged"]);
  assert.equal(git(root, "status", "--porcelain"), "");
  // Every later landing was a fast-forward-able merge or a gated one; the base the run expects is the base.
  assert.equal(h.host.expected.base, git(root, "rev-parse", "main"));
});

test("a carried branch goes before a new one when both are waiting", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" }, 3: { "c.txt": "c\n" } });
  const h = harness(root);
  h.landing.push(outcome(root, "1"));
  h.landing.push(outcome(root, "2"));
  h.landing.push(outcome(root, "3", { carried: true }));
  h.landing.close();
  await h.landing.run();
  assert.deepEqual(mergeOrder(root), ["3", "1", "2"]);
});

test("the queue ranks by priority and keeps arrival order among equals", async () => {
  const queue = createQueue<{ id: string; first?: boolean }>((o) => (o.first ? 1 : 0));
  for (const item of [{ id: "a" }, { id: "b", first: true }, { id: "c" }, { id: "d", first: true }]) queue.push(item);
  queue.close();
  const seen: string[] = [];
  await queue.run(1, async (o) => void seen.push(o.id));
  assert.deepEqual(seen, ["b", "d", "a", "c"]);
});

test("a pipeline finishing during a landing does not trip the guard", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const checks: string[] = [];
  let h!: ReturnType<typeof harness>;
  // The merge of 2 is gated in a sandbox: the base has not moved yet while it runs, and moves the moment it is green.
  h = harness(root, {
    gate: async () => {
      for (let i = 0; i < 5; i++) {
        await h.host.check("after #9").catch((e) => checks.push(String(e)));
        await sleep(5);
      }
      return GREEN;
    },
  });
  // A pipeline's check fires as fast as it can throughout the landing, before, during and after each merge.
  let polling = true;
  const hammer = (async () => {
    while (polling) {
      await h.host.check("after #9").catch((e) => checks.push(String(e)));
      await sleep(0);
    }
  })();
  try {
    await runPipelines(root, h, { 1: 10, 2: 20 });
  } finally {
    polling = false;
    await hammer;
  }
  assert.deepEqual(checks, []);
  assert.deepEqual(mergeOrder(root), ["1", "2"]);
  await h.host.check("at the end");
});

test("a hand commit on the base mid-run still stops the run", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" }, 3: { "c.txt": "c\n" } });
  const h = harness(root);
  h.landing.push(outcome(root, "1"));
  h.landing.close();
  await h.landing.run();
  assert.deepEqual(mergeOrder(root), ["1"]);
  // A person commits to the base while the other pipelines run.
  git(root, "commit", "-q", "--allow-empty", "-m", "by hand");
  // A pipeline's own check sees it ...
  await assert.rejects(h.host.check("after #2"), /STOPPED after #2: main moved while sandboxes ran \([0-9a-f]+ by .*: by hand\)/);
  // ... and so does the worker, before it merges anything over it.
  const next = harness(root);
  next.host.expected.base = h.host.expected.base;
  next.landing.push(outcome(root, "2"));
  next.landing.push(outcome(root, "3"));
  next.landing.close();
  await next.landing.run();
  assert.match(String(why(next.stop)), /^tampered: .*STOPPED before landing #2: main moved/);
  assert.deepEqual(next.stopped, ["2", "3"]);
  assert.deepEqual(next.settled, []);
  assert.deepEqual(mergeOrder(root), ["1"]);
});

test("a hand commit while a merge is gated in a sandbox stops the run and the merge does not land", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const h = harness(root, {
    gate: async () => {
      git(root, "commit", "-q", "--allow-empty", "-m", "by hand");
      return GREEN;
    },
  });
  h.landing.push(outcome(root, "1"));
  h.landing.push(outcome(root, "2"));
  h.landing.close();
  await h.landing.run();
  assert.match(String(why(h.stop)), /^tampered: .*STOPPED after landing agent\/issue-2 in a sandbox: main moved/);
  assert.deepEqual(mergeOrder(root), ["1"]);
  assert.equal(git(root, "log", "-1", "--format=%s", "main"), "by hand");
  assert.deepEqual(h.stopped, ["2"]);
});

test("the second of two tickets on the same lines is a conflict naming the first", async () => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n" } });
  const h = harness(root);
  await runPipelines(root, h, { 1: 10, 2: 60 });
  assert.deepEqual(h.settled.map((s) => s.landed), [{ kind: "merged" }, { kind: "conflict", files: ["shared.txt"], with: ["1"] }]);
  assert.match(h.states["2"].note ?? "", /with #1: shared\.txt/);
  assert.equal(h.states["2"].state, "conflict");
  assert.equal(git(root, "show", "main:shared.txt"), "one");
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(root, "branch", "--list", "sandcastle/*"), "");
});

test("a conflict is attributed to the record, so a squashed branch deleted at its landing is still named", async () => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n" }, 3: { "c.txt": "c\n" } });
  const h = harness(root, { land: "squash" });
  h.landing.push(outcome(root, "1"));
  h.landing.push(outcome(root, "3"));
  h.landing.push(outcome(root, "2"));
  h.landing.close();
  // Squashed and gone right after its landing, not at the end of the run.
  let seenAfterFirst: string | undefined;
  const run = h.landing.run();
  while (h.settled.length < 1) await sleep(1);
  seenAfterFirst = git(root, "branch", "--list", "agent/issue-1");
  await run;
  assert.equal(seenAfterFirst, "");
  assert.equal(git(root, "branch", "--list", "agent/issue-1", "agent/issue-3"), "");
  assert.deepEqual(h.settled.map((s) => s.landed.kind), ["merged", "merged", "conflict"]);
  // 3 landed too but touches nothing 2 does: not named.
  assert.deepEqual(h.settled[2].landed, { kind: "conflict", files: ["shared.txt"], with: ["1"] });
  // The conflicted branch is kept for the next run.
  assert.notEqual(git(root, "branch", "--list", "agent/issue-2"), "");
});

test("a merged tree red with an earlier ticket names the pair and lands nothing", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  // Each branch is green alone; together they are not.
  const h = harness(root, { gate: async (box) => ((await box.exec("test -e a.txt && test -e b.txt")).exitCode === 0 ? RED : GREEN) });
  await runPipelines(root, h, { 1: 10, 2: 60 });
  assert.deepEqual(h.settled.map((s) => s.landed), [{ kind: "merged" }, { kind: "red", with: ["1"], gates: ["test"] }]);
  assert.equal(h.states["2"].state, "red");
  assert.equal(h.states["2"].note, "red with #1");
  assert.deepEqual(mergeOrder(root), ["1"]);
  assert.equal(git(root, "ls-tree", "--name-only", "main", "b.txt"), "");
  assert.deepEqual(h.calls, ["close 1"]);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(root, "branch", "--list", "sandcastle/*"), "");
  // The one comment the ticket gets says so, with the pair.
  const comment = notLandedComment(undefined, undefined, { branch: "agent/issue-2", base: "main", with: ["1"], gates: ["test"] });
  assert.match(comment ?? "", /green on its own, but merged into `main` the gates were red \(test\)\. Landed on `main` since this branch forked: #1\./);
});

test("a branch that holds the base lands without a sandbox", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  // The merge of 1 into a base it already holds would be gated, and this gate fails the test if it runs.
  const h = harness(root, { gate: async () => RED });
  await runPipelines(root, h, { 1: 5 });
  assert.deepEqual(h.settled.map((s) => s.landed.kind), ["merged"]);
});

test("gc.auto is 0 in the environment of every host git", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  disableHostGitGc();
  disableHostGitGc();
  const env = Object.entries(process.env).filter(([k]) => /^GIT_CONFIG_KEY_/.test(k));
  assert.equal(env.filter(([, v]) => v === "gc.auto").length, 1, "set once, however many turns of a run ask");
  // The same process environment every sh() call passes to git: the landing merge and the sandbox's host-side git.
  assert.equal(git(root, "config", "--show-origin", "--get", "gc.auto"), "command line:\t0");
  const h = harness(root);
  h.landing.push(outcome(root, "1"));
  h.landing.close();
  await h.landing.run();
  assert.equal(git(root, "config", "--get", "gc.auto"), "0");
  // And the run turns it on at the start, beside the hooks.
  assert.match(readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8"), /disableHostGitHooks\(\);\n\s+disableHostGitGc\(\);/);
});

test("a dry run writes nothing", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" }, 3: { ".github/workflows/ci.yml": "on: push\n" } });
  const before = git(root, "rev-parse", "main");
  const refs = git(root, "for-each-ref", "--format=%(refname) %(objectname)");
  const h = harness(root, { dryRun: true });
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await runPipelines(root, h, { 1: 5, 2: 30, 3: 55 });
  } finally {
    console.log = log;
  }
  assert.deepEqual(lines, ["[dry run] would merge agent/issue-1 and close #1", "[dry run] would merge agent/issue-2 and close #2"]);
  assert.equal(h.states["1"].note, "dry run: would merge");
  assert.equal(h.states["1"].state, "ready");
  assert.match(h.states["3"].note ?? "", /^dry run: would hold: \.github\/workflows\/ci\.yml/);
  assert.deepEqual(h.calls, []);
  assert.equal(git(root, "rev-parse", "main"), before);
  assert.equal(git(root, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.equal(git(root, "worktree", "list").split("\n").length, 1);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(h.host.expected.base, before);
  assert.equal(existsSync(join(root, "a.txt")), false);
});

test("a landing outside the worker is still a plain landOne: the base the run expects follows it", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const h = harness(root);
  const before = h.host.expected.base;
  assert.equal((await landOne(h.ctx, outcome(root, "1"))).kind, "merged");
  assert.notEqual(h.host.expected.base, before);
  assert.equal(h.host.expected.base, git(root, "rev-parse", "main"));
  assert.equal((await landOne(h.ctx, outcome(root, "2"))).kind, "merged");
  assert.equal(h.host.expected.base, git(root, "rev-parse", "main"));
  await h.host.check("after both");
});

test("the pool cap leaves a slot for landing when CONCURRENCY equals the pool limit", () => {
  assert.equal(pipelineWorkers(6, 20, 6, true), 5);
  assert.equal(pipelineWorkers(4, 20, 4, true), 3);
  // Never fewer than one, however small the pool.
  assert.equal(pipelineWorkers(3, 20, 1, true), 1);
  assert.equal(pipelineWorkers(2, 20, 2, true), 1);
  // Room to spare, or fewer tickets than slots: unchanged.
  assert.equal(pipelineWorkers(3, 20, 6, true), 3);
  assert.equal(pipelineWorkers(6, 2, 6, true), 2);
  // A dry run lands nothing, so it keeps every slot.
  assert.equal(pipelineWorkers(6, 20, 6, false), 6);
});

test("a .git change found by the writer's own check stops landing, and no host git runs after it", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  const marker = join(TMP, `fsmonitor-ran-${n++}`);
  const h = harness(root);
  // After the worker's check and before the merge: a sandbox still running plants a command
  // that the host's next `git status` would run.
  h.ctx.withdrawal = () => {
    git(root, "config", "core.fsmonitor", `touch ${marker}`);
    return undefined;
  };
  h.landing.push(outcome(root, "1"));
  h.landing.push(outcome(root, "2"));
  h.landing.close();
  await h.landing.run();
  assert.equal(existsSync(marker), false, "a host git call ran the planted command");
  // The writer's refusal is the host's failure, which the stop state reads without being told.
  assert.match(String(why(h.stop)), /^host failed: .*STOPPED before writing to the base branch: .*config changed while sandboxes ran/);
  assert.deepEqual(h.stop.causes.map((c) => c.kind), ["host failed"]);
  assert.deepEqual(h.stopped, ["1", "2"]);
  assert.deepEqual(h.settled, []);
});

test("a hand commit made after the worker's check is not merged over, even on the last ticket", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" } });
  const h = harness(root);
  // As while the landing waits for a sandbox slot: the branch no longer holds the base, so its
  // merge is made in a sandbox, which must not take the moved base as the one the run expects.
  h.ctx.withdrawal = () => {
    git(root, "commit", "-q", "--allow-empty", "-m", "by hand");
    return undefined;
  };
  h.landing.push(outcome(root, "1"));
  h.landing.close();
  await h.landing.run();
  assert.match(String(why(h.stop)), /^tampered: .*STOPPED before landing agent\/issue-1 in a sandbox: main moved/);
  assert.deepEqual(h.stopped, ["1"]);
  assert.deepEqual(mergeOrder(root), []);
  assert.equal(git(root, "log", "-1", "--format=%s", "main"), "by hand");
});
