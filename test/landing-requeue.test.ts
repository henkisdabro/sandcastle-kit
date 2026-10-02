// A ticket that conflicts or goes red at landing is requeued once, in the same run (createFlow in
// src/landing.ts): its pipeline runs again on the land-only path, and a second conflict or red holds
// it for the next run. Fake pipelines over the real landing worker and the real queues, temp repos,
// a fake tracker and a host worktree for the sandbox: no Docker, no gh, no network. Paths come from
// node:path and os.tmpdir(), and the fake sandbox strips the `timeout -k` wrapper macOS lacks.
//
//   pnpm exec tsx --test test/landing-requeue.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { againLine, createFlow, createHostGit, createLanding, requeuedLine } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { landOnlyHead, recordHead } = await import("../src/run.ts");
const { createQueue } = await import("../src/schedule.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Landed = import("../src/landing.ts").Landed;
type Waiting = import("../src/landing.ts").Waiting;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-requeue-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

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

type Issue = { id: string };
type Pipeline = (issue: Issue, attempt: number) => Promise<Waiting | undefined>;

// The wiring burndown.ts makes, with `pipeline` standing in for a ticket's sandbox pipeline: a green
// outcome goes to the landing worker, a landing's conflict or red may send the ticket back to the
// pipeline queue, and the queues close once every ticket has had its last word.
const run = async (root: string, ids: string[], pipeline: Pipeline, gate: Ctx["gate"] = async () => GREEN, workers = 2) => {
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const host = createHostGit(project, gitFingerprint(project));
  const states: Record<string, { state?: string; note?: string; requeued?: string }> = {};
  const calls: string[] = [];
  const ctx: Ctx = {
    project,
    tracker: {
      ref: (id: string) => `#${id}`,
      close: (id: string) => void calls.push(`close ${id}`),
      comment: (id: string) => void calls.push(`comment ${id}`),
      hold: (id: string) => void calls.push(`hold ${id}`),
    } as unknown as Ctx["tracker"],
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: { ticket: (id, fields) => void (states[id] = { ...states[id], ...fields }) },
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host,
    gate,
    landed: new Map(),
  };
  const issues = ids.map((id) => ({ id }));
  const byId = new Map(issues.map((i) => [i.id, i]));
  const queue = createQueue<Issue>();
  for (const i of issues) queue.push(i);
  const final: { issue: string; landed: Landed; line?: string }[] = [];
  const sentBack: string[] = [];
  const attempts = new Map<string, number>();
  const landing = createLanding(ctx, {
    settled: (o, landed) => {
      const again = flow.retry(byId.get(o.issue)!, landed, landing.stop !== undefined);
      if (again !== undefined) {
        sentBack.push(`${o.issue}: ${again}`);
        return;
      }
      const earlier = flow.earlier(o.issue);
      const line = earlier && (landed.kind === "conflict" || landed.kind === "red") ? againLine(landed.kind, [...new Set([...earlier.with, ...landed.with])]) : undefined;
      final.push({ issue: o.issue, landed, line });
      flow.finish();
    },
    stopped: () => flow.finish(),
  });
  const flow = createFlow(issues.length, queue, landing);
  const pipelines = queue.run(
    workers,
    flow.work(async (issue) => {
      const attempt = (attempts.get(issue.id) ?? 0) + 1;
      attempts.set(issue.id, attempt);
      const o = await pipeline(issue, attempt);
      if (!o) return false;
      landing.push(o);
      return true;
    }),
  );
  await Promise.all([pipelines, landing.run()]);
  return { final, sentBack, states, calls, host, attempts };
};

const mergeOrder = (root: string) =>
  git(root, "log", "--first-parent", "--reverse", "--format=%s", "main")
    .split("\n")
    .flatMap((s) => /^Merge agent\/issue-(\d+) /.exec(s)?.[1] ?? []);

// What a land-only pipeline leaves on the branch: the base merged in and the conflict resolved by hand.
const mergeBaseIn = (root: string, id: string, resolved: Record<string, string>) => {
  const path = join(TMP, `wt${n++}`);
  git(root, "worktree", "add", "-q", path, `agent/issue-${id}`);
  try {
    try {
      git(path, "merge", "--no-edit", "main");
    } catch {
      /* the conflict is resolved below */
    }
    for (const [file, text] of Object.entries(resolved)) {
      writeFileSync(join(path, file), text);
      git(path, "add", file);
    }
    git(path, "commit", "-q", "--no-edit", "-m", `Merge main into agent/issue-${id}`);
  } finally {
    git(root, "worktree", "remove", "--force", path);
  }
};

// What burndown.ts's pipeline does at its start and its green end, in the part the heads record decides.
const stages: string[] = [];
const fakePipeline =
  (root: string, onSecond: (id: string) => void): Pipeline =>
  async ({ id }, attempt) => {
    const branch = `agent/issue-${id}`;
    if (landOnlyHead(root, "main", id) === undefined) {
      stages.push(`${id}#${attempt}: implement, review`);
    } else {
      stages.push(`${id}#${attempt}: land only`);
      onSecond(id);
    }
    const head = git(root, "rev-parse", branch);
    recordHead(root, id, { branch, reviewed: head, green: head }, "run");
    return outcome(root, id, { carried: attempt > 1 });
  };

test("a conflict is requeued and lands on the second try in one run", async () => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n" } });
  stages.length = 0;
  const pipeline = fakePipeline(root, (id) => mergeBaseIn(root, id, { "shared.txt": "one\ntwo\n" }));
  // 1 lands first; 2 conflicts with it, is requeued, and its second pipeline resolves the merge.
  const slow: Pipeline = async (issue, attempt) => {
    if (issue.id === "2" && attempt === 1) await new Promise((r) => setTimeout(r, 60));
    return pipeline(issue, attempt);
  };
  const r = await run(root, ["1", "2"], slow);
  assert.deepEqual(r.final.map((f) => [f.issue, f.landed.kind]), [["1", "merged"], ["2", "merged"]]);
  assert.deepEqual(r.sentBack, ["2: requeued after conflict with #1"]);
  assert.deepEqual(mergeOrder(root), ["1", "2"]);
  assert.equal(git(root, "show", "main:shared.txt"), "one\ntwo");
  assert.deepEqual(r.calls, ["close 1", "close 2"]);
  assert.equal(r.attempts.get("2"), 2);
  assert.equal(r.attempts.get("1"), 1);
  await r.host.check("at the end");
});

test("a second conflict holds the ticket, naming both tickets it collided with", async () => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n", "other.txt": "two\n" }, 3: { "other.txt": "three\n" } });
  // 2 meets 1 on shared.txt, and while its second pipeline runs 3 lands on other.txt: the second try conflicts with 3.
  // Ordered by events, not by sleeping: 3's pipeline ends once 2's second one has merged the base in,
  // and 2's second one ends once 3 has landed.
  let mergedIn!: () => void;
  const baseMerged = new Promise<void>((resolve) => (mergedIn = resolve));
  const pipeline: Pipeline = async (issue, attempt) => {
    if (issue.id === "2" && attempt === 1) await new Promise((r) => setTimeout(r, 40));
    if (issue.id === "3") await baseMerged;
    if (issue.id === "2" && attempt === 2) {
      mergeBaseIn(root, "2", { "shared.txt": "one\ntwo\n" });
      mergedIn();
      while (!mergeOrder(root).includes("3")) await new Promise((r) => setTimeout(r, 5));
    }
    return outcome(root, issue.id, { carried: attempt > 1 });
  };
  const r = await run(root, ["1", "2", "3"], pipeline, async () => GREEN, 3);
  const two = r.final.find((f) => f.issue === "2")!;
  assert.equal(two.landed.kind, "conflict");
  assert.equal(two.line, "conflicted again with #1, #3 after a requeue");
  assert.deepEqual(r.sentBack, ["2: requeued after conflict with #1"]);
  assert.equal(r.attempts.get("2"), 2, "requeued once, never twice");
  assert.deepEqual(mergeOrder(root).sort(), ["1", "3"]);
  assert.equal(r.states["2"].state, "conflict");
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(root, "branch", "--list", "sandcastle/*"), "");
});

test("a merged tree that is red is requeued once too, and a second red holds it", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  // Each branch is green alone; together they never are.
  const together: Ctx["gate"] = async (box) => ((await box.exec("test -e a.txt && test -e b.txt")).exitCode === 0 ? RED : GREEN);
  const pipeline: Pipeline = async (issue, attempt) => {
    if (issue.id === "2" && attempt === 1) await new Promise((r) => setTimeout(r, 50));
    return outcome(root, issue.id, { carried: attempt > 1 });
  };
  const r = await run(root, ["1", "2"], pipeline, together);
  assert.deepEqual(r.sentBack, ["2: requeued after red with #1"]);
  const two = r.final.find((f) => f.issue === "2")!;
  assert.deepEqual(two.landed, { kind: "red", with: ["1"], gates: ["test"] });
  assert.equal(two.line, "red again with #1 after a requeue");
  assert.equal(r.attempts.get("2"), 2);
  assert.deepEqual(mergeOrder(root), ["1"]);
});

test("a requeued ticket runs no implement or full review when its heads record matches", async () => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n" } });
  stages.length = 0;
  const pipeline = fakePipeline(root, (id) => mergeBaseIn(root, id, { "shared.txt": "one\ntwo\n" }));
  const slow: Pipeline = async (issue, attempt) => {
    if (issue.id === "2" && attempt === 1) await new Promise((r) => setTimeout(r, 60));
    return pipeline(issue, attempt);
  };
  await run(root, ["1", "2"], slow);
  assert.deepEqual(stages.filter((s) => s.startsWith("2#")), ["2#1: implement, review", "2#2: land only"]);
});

test("without a matching heads record the second pipeline takes the full path, as a carried branch does today", async () => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n" } });
  stages.length = 0;
  const pipeline: Pipeline = async ({ id }, attempt) => {
    // No record written, so there is nothing for landOnlyHead to match.
    stages.push(`${id}#${attempt}: ${landOnlyHead(root, "main", id) === undefined ? "implement, review" : "land only"}`);
    if (id === "2" && attempt === 1) await new Promise((r) => setTimeout(r, 60));
    if (id === "2" && attempt === 2) mergeBaseIn(root, id, { "shared.txt": "one\ntwo\n" });
    return outcome(root, id, { carried: attempt > 1 });
  };
  const r = await run(root, ["1", "2"], pipeline);
  assert.deepEqual(stages.filter((s) => s.startsWith("2#")), ["2#1: implement, review", "2#2: implement, review"]);
  assert.deepEqual(r.final.map((f) => f.landed.kind), ["merged", "merged"]);
});

test("a ticket whose pipeline ends without landing, or whose landing needs no requeue, ends the run once", async () => {
  const root = makeRepo({ 1: { "a.txt": "a\n" }, 2: { "b.txt": "b\n" } });
  // 2's pipeline ends red (nothing to land); 1 lands.
  const r = await run(root, ["1", "2"], async (issue) => (issue.id === "2" ? undefined : outcome(root, issue.id)));
  assert.deepEqual(r.final.map((f) => f.landed.kind), ["merged"]);
  assert.deepEqual(r.sentBack, []);
  // No tickets at all: closed at once.
  const empty = createQueue<Issue>();
  const closed = { n: 0 };
  createFlow(0, empty, { close: () => void closed.n++ });
  await empty.run(1, async () => {});
  assert.equal(closed.n, 1);
});

test("a run that is stopping does not requeue, and the lines read as the status view shows them", () => {
  const queue = createQueue<Issue>();
  const flow = createFlow(1, queue, { close() {} });
  const conflict: Landed = { kind: "conflict", files: ["a.txt"], with: ["1"] };
  assert.equal(flow.retry({ id: "2" }, conflict, true), undefined);
  assert.equal(queue.size, 0);
  assert.equal(flow.retry({ id: "2" }, { kind: "merged" }), undefined);
  assert.equal(flow.retry({ id: "2" }, { kind: "not-landed", reason: "x" }), undefined);
  assert.equal(flow.retry({ id: "2" }, conflict), "requeued after conflict with #1");
  assert.equal(flow.retry({ id: "2" }, conflict), undefined);
  assert.equal(queue.size, 1);
  assert.equal(requeuedLine("red", []), "requeued after red");
  assert.equal(againLine("conflict", ["1", "3"]), "conflicted again with #1, #3 after a requeue");
});
