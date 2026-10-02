// A ticket that conflicts or goes red at landing is requeued once, in the same run (createFlow in
// src/landing.ts): its pipeline runs again on the land-only path, and a second conflict or red holds
// it for the next run. The landing worker's `settled`/`stopped` and the bookkeeping of a ticket sent
// back are `createSettling` (src/landing.ts), the code `burndown()` runs: the first tests run it over
// fake pipelines, the real landing worker and queues, temp repos, a fake tracker and a host worktree
// for the sandbox; the later ones drive it with made-up landings and a run record in a temp dir. No
// Docker, no gh, no network. Paths come from node:path and os.tmpdir(), and the fake sandbox strips
// the `timeout -k` wrapper macOS lacks.
//
//   pnpm exec tsx --test test/landing-requeue.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { againLine, createFlow, createHostGit, createLanding, createSettling, requeuedLine } = await import("../src/landing.ts");
const { notLandedComment } = await import("../src/burndown.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { landOnlyHead, recordHead, recordRun } = await import("../src/run.ts");
const { createQueue } = await import("../src/schedule.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Landed = import("../src/landing.ts").Landed;
type Waiting = import("../src/landing.ts").Waiting;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;
type Landings = import("../src/landing.ts").Landings;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-landing-requeue-"));
// recordRun finishes its record in an exit handler, so the temp directory goes after it: registered once the
// first record exists, which puts it behind recordRun's own handler.
let cleanup = false;
const removeAtExit = () => {
  if (cleanup) return;
  cleanup = true;
  process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
};
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

// The lists burndown() keeps, and a run record in a directory of its own (never the repo under test).
const newLists = (): Landings => ({
  merged: [],
  regenerated: new Map(),
  conflicted: [],
  redMerged: [],
  heldBack: [],
  failedToLand: [],
  skipped: [],
  withdrawn: [],
  takenBack: [],
  closedEarlier: [],
  closeFailed: [],
});
const newRecord = () => {
  const project = { root: join(TMP, `record${n++}`), name: "fixture" } as unknown as Project;
  const record = recordRun(project);
  removeAtExit();
  const written = () => JSON.parse(readFileSync(join(project.root, ".sandcastle/logs/run.json"), "utf8")).tickets ?? {};
  return { record, written };
};

// The settling burndown.ts makes, over a queue of pipelines and a flow that closes both queues.
const settlingOver = (ids: string[], record: ReturnType<typeof recordRun>, opts: { stopping?: () => boolean } = {}) => {
  const issues = ids.map((id) => ({ id }));
  // Only what landing sends back: the tickets themselves are with the pipelines already.
  const queue = createQueue<Issue>();
  const lists = newLists();
  const said: string[] = [];
  const outcomes: Record<string, string> = {};
  const closed = { n: 0 };
  const flow = createFlow(issues.length, queue, { close: () => void closed.n++ });
  const settling = createSettling<Issue>({
    lists,
    run: record,
    flow,
    byId: new Map(issues.map((i) => [i.id, i])),
    stopping: opts.stopping ?? (() => false),
    dealt: () => {},
    afterLanding: () => flow.finish(),
    onStop: () => {},
    outcomes: (lines) => void Object.assign(outcomes, lines),
    ref: (id) => `#${id}`,
    say: (line) => void said.push(line),
  });
  return { settling, lists, said, outcomes, queue, flow, closed };
};

// The wiring burndown.ts makes, with `pipeline` standing in for a ticket's sandbox pipeline: a green
// outcome goes to the landing worker, a landing's conflict or red may send the ticket back to the
// pipeline queue, and the queues close once every ticket has had its last word.
const run = async (root: string, ids: string[], pipeline: Pipeline, gate: Ctx["gate"] = async () => GREEN, workers = 2) => {
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  const host = createHostGit(project, gitFingerprint(project));
  const { record, written } = newRecord();
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
    run: record,
    dryRun: false,
    opener: opener(root),
    withdrawal: () => undefined,
    host,
    gate,
    landed: new Map(),
  };
  const issues = ids.map((id) => ({ id }));
  const queue = createQueue<Issue>();
  for (const i of issues) queue.push(i);
  const final: { issue: string; landed: Landed; line?: string }[] = [];
  const attempts = new Map<string, number>();
  const lists = newLists();
  const sentBack: string[] = [];
  const flow = createFlow(issues.length, queue, { close: () => landing.close() });
  const settling = createSettling<Issue>({
    lists,
    run: record,
    flow,
    byId: new Map(issues.map((i) => [i.id, i])),
    stopping: () => landing.stop !== undefined || host.failed !== undefined,
    dealt: () => {},
    afterLanding: () => flow.finish(),
    onStop: () => {},
    outcomes: () => {},
    ref: (id) => `#${id}`,
    say: (line) => void (/; its pipeline runs again in this run\.$/.test(line) && sentBack.push(line.replace("; its pipeline runs again in this run.", "").replace(/^#(\d+): /, "$1: "))),
  });
  const landing = createLanding(ctx, {
    settled: async (o, landed) => {
      const before = sentBack.length;
      await settling.settled(o, landed);
      if (sentBack.length === before) final.push({ issue: o.issue, landed, line: settling.againNote.get(o.issue) });
    },
    stopped: settling.stopped,
  });
  const pipelines = queue.run(
    workers,
    flow.work(async (issue) => {
      const attempt = (attempts.get(issue.id) ?? 0) + 1;
      attempts.set(issue.id, attempt);
      settling.began(issue.id);
      const o = await pipeline(issue, attempt);
      if (!o) return false;
      landing.push(o);
      return true;
    }),
  );
  await Promise.all([pipelines, landing.run()]);
  return { final, sentBack, states: written(), calls, host, attempts, lists, settling };
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
  assert.equal(two.line, "conflicted again with #1, #3 after a requeue: other.txt");
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

// ---------------------------------------------------------------------------
// The bookkeeping of a ticket sent back: createSettling over made-up landings and a run record.
// ---------------------------------------------------------------------------

const waiting = (id: string): Waiting => ({ issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0 });
// What landOne writes to the ticket before `settled` hears of it.
const landedAs = (record: ReturnType<typeof recordRun>, id: string, state: string, note: string) => record.ticket(id, { state, note });

test("conflict, requeued, merged: the second landing is the outcome and the status view is not left prefixed", async () => {
  const { record, written } = newRecord();
  const { settling, lists, said, outcomes, queue } = settlingOver(["2"], record);
  landedAs(record, "2", "conflict", "with #1: shared.txt");
  await settling.settled(waiting("2"), { kind: "conflict", files: ["shared.txt"], with: ["1"] });
  assert.equal(queue.size, 1, "put back on the pipeline queue");
  assert.deepEqual(said, ["#2: requeued after conflict with #1; its pipeline runs again in this run."]);
  assert.deepEqual(written()["2"], { ...written()["2"], state: "queued", note: "requeued after conflict with #1", requeued: "requeued after conflict with #1" });
  assert.equal(settling.requeuedAs.get("2"), "requeued after conflict with #1");
  assert.deepEqual(lists.conflicted, [], "nothing is accounted while the second attempt is to come");
  // The second pipeline starts, and its landing merges.
  settling.began("2");
  await settling.settled(waiting("2"), { kind: "merged" });
  assert.deepEqual(lists.merged, ["2"]);
  assert.deepEqual(lists.conflicted, []);
  assert.equal(settling.lines().get("2"), "merged");
  assert.deepEqual(outcomes, {});
});

test("conflict, requeued, conflict again: the outcome keeps the files, and the comment names both attempts' tickets", async () => {
  const { record, written } = newRecord();
  const { settling, lists } = settlingOver(["2"], record);
  landedAs(record, "2", "conflict", "with #1: shared.txt");
  await settling.settled(waiting("2"), { kind: "conflict", files: ["shared.txt"], with: ["1"] });
  settling.began("2");
  landedAs(record, "2", "conflict", "with #3: other.txt, more.txt");
  await settling.settled(waiting("2"), { kind: "conflict", files: ["other.txt", "more.txt"], with: ["3"] });
  assert.equal(settling.lines().get("2"), "merge conflict: conflicted again with #1, #3 after a requeue: other.txt, more.txt");
  assert.equal(written()["2"].note, "conflicted again with #1, #3 after a requeue: other.txt, more.txt");
  assert.equal(written()["2"].state, "conflict");
  assert.deepEqual(lists.conflicted.map((c) => [c.issue, c.with, c.files]), [["2", ["1", "3"], ["other.txt", "more.txt"]]]);
  const c = lists.conflicted[0];
  const comment = notLandedComment(undefined, { branch: c.branch, base: "main", files: c.files, with: c.with })!;
  assert.match(comment, /conflicted \(with #1, #3: other\.txt, more\.txt\)/);
});

test("red, requeued, red again: no doubled 'red', and the comment names both attempts' tickets", async () => {
  const { record, written } = newRecord();
  const { settling, lists, queue } = settlingOver(["2"], record);
  landedAs(record, "2", "red", "test red with #1");
  await settling.settled(waiting("2"), { kind: "red", with: ["1"], gates: ["test"] });
  assert.equal(queue.size, 1);
  assert.equal(written()["2"].requeued, "requeued after red with #1");
  settling.began("2");
  landedAs(record, "2", "red", "test red with #3");
  await settling.settled(waiting("2"), { kind: "red", with: ["3"], gates: ["test"] });
  assert.equal(settling.lines().get("2"), "red again with #1, #3 after a requeue");
  assert.equal(written()["2"].note, "red again with #1, #3 after a requeue");
  assert.deepEqual(lists.redMerged, [{ issue: "2", branch: "agent/issue-2", with: ["1", "3"], gates: ["test"] }]);
  const r = lists.redMerged[0];
  assert.match(notLandedComment(undefined, undefined, { branch: r.branch, base: "main", with: r.with, gates: r.gates })!, /since this branch forked: #1, #3/);
});

test("a first red or conflict that is not requeued keeps the plain outcome lines", async () => {
  const { record } = newRecord();
  const { settling } = settlingOver(["2", "3"], record, { stopping: () => true });
  await settling.settled(waiting("2"), { kind: "red", with: ["1"], gates: ["test"] });
  await settling.settled(waiting("3"), { kind: "conflict", files: ["a.txt", "b.txt", "c.txt", "d.txt"], with: ["1"] });
  assert.equal(settling.lines().get("2"), "red when merged with #1");
  assert.equal(settling.lines().get("3"), "merge conflict: with #1: a.txt, b.txt, c.txt and 1 more");
});

test("requeued, then withdrawn before the second start: withdrawn, not green, and the first pipeline's entry dropped", async () => {
  const { record, written } = newRecord();
  const { settling, lists } = settlingOver(["2"], record);
  landedAs(record, "2", "conflict", "with #1: shared.txt");
  await settling.settled(waiting("2"), { kind: "conflict", files: ["shared.txt"], with: ["1"] });
  const results = ["first pipeline's green"];
  settling.withdraw("2", { reason: "closed during the run" }, () => results.pop());
  assert.deepEqual(results, []);
  assert.deepEqual(lists.withdrawn, [{ issue: "2", reason: "closed during the run" }]);
  assert.deepEqual(lists.conflicted, [], "its first landing does not stand: it was withdrawn since");
  assert.equal(settling.lines().get("2"), "withdrawn: closed during the run");
  assert.equal(written()["2"].state, "withdrawn");
  assert.equal(written()["2"].note, "closed - not started");
  assert.equal(written()["2"].requeued, null);
  assert.equal(settling.requeuedAs.has("2"), false);
  // A ticket that was never sent back has nothing to drop and is not accounted here.
  settling.withdraw("9", { reason: "closed during the run" }, () => assert.fail("nothing was sent back"));
  assert.deepEqual(lists.withdrawn.map((w) => w.issue), ["2"]);
});

test("requeued, then the run stops: the first outcome stands, and the status view is no longer told it was requeued", async () => {
  const { record, written } = newRecord();
  const { settling, lists } = settlingOver(["2", "3"], record);
  landedAs(record, "2", "conflict", "with #1: shared.txt");
  await settling.settled(waiting("2"), { kind: "conflict", files: ["shared.txt"], with: ["1"] });
  landedAs(record, "3", "red", "test red with #1");
  await settling.settled(waiting("3"), { kind: "red", with: ["1"], gates: ["test"] });
  assert.equal(written()["2"].requeued, "requeued after conflict with #1");
  // The pipelines drain without starting either.
  assert.equal(settling.keepFirst("2"), true);
  assert.equal(settling.keepFirst("3"), true);
  assert.equal(settling.keepFirst("2"), false, "once");
  assert.deepEqual(lists.conflicted.map((c) => c.issue), ["2"]);
  assert.deepEqual(lists.redMerged.map((r) => r.issue), ["3"]);
  assert.equal(settling.lines().get("2"), "merge conflict: with #1: shared.txt");
  assert.equal(settling.lines().get("3"), "red when merged with #1");
  assert.deepEqual([written()["2"].state, written()["2"].note, written()["2"].requeued], ["conflict", "with #1: shared.txt", null]);
  assert.deepEqual([written()["3"].state, written()["3"].note, written()["3"].requeued], ["red", "test red with #1", null]);
});

test("a push to a closed queue: the normal conflict outcome, nothing left queued or recorded as requeued", async () => {
  const { record, written } = newRecord();
  const { settling, lists, queue, closed, said } = settlingOver(["2"], record);
  landedAs(record, "2", "conflict", "with #1: shared.txt");
  queue.close();
  await settling.settled(waiting("2"), { kind: "conflict", files: ["shared.txt"], with: ["1"] });
  assert.equal(queue.size, 0);
  assert.deepEqual(said, []);
  assert.equal(settling.requeuedAs.has("2"), false);
  assert.equal(settling.keepFirst("2"), false, "nothing is held back for a second attempt");
  assert.deepEqual(lists.conflicted.map((c) => [c.issue, c.with]), [["2", ["1"]]]);
  assert.equal(settling.lines().get("2"), "merge conflict: with #1: shared.txt");
  assert.deepEqual([written()["2"].state, written()["2"].note, written()["2"].requeued], ["conflict", "with #1: shared.txt", null]);
  assert.equal(closed.n, 1, "its last word was said: the queues close");
});

test("a ticket is on the queue only after its requeue is recorded", async () => {
  const { record } = newRecord();
  const seen: string[] = [];
  const spy = { ...record, ticket: (id: string, f: Parameters<typeof record.ticket>[1]) => (seen.push(`write ${f.state}`), record.ticket(id, f)) };
  const { settling, queue } = settlingOver(["2"], spy as typeof record);
  const push = queue.push;
  queue.push = (item) => (seen.push("push"), push(item));
  await settling.settled(waiting("2"), { kind: "conflict", files: ["a.txt"], with: ["1"] });
  assert.deepEqual(seen, ["write queued", "push"]);
});
