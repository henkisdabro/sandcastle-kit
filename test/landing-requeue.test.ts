// A ticket that conflicts or goes red at landing is requeued once, in the same run: the scheduler's
// requeue-once rule (createSchedule in src/schedule.ts). Its second attempt runs on the land-only
// path, and a second conflict or red holds it for the next run. The record's side of a requeue is
// `createRequeueRecord` (src/landing.ts), which burndown.ts hands what the scheduler tells. Every
// test drives `createSchedule(plan).run(work)`: the first ones with fake attempts and the real
// `landOne` (`landingWork`) on temp repos, a fake tracker and a host worktree for the sandbox; the
// later ones with made-up landings and a run record in a temp dir. No Docker, no gh, no network.
// Paths come from node:path and os.tmpdir(), and the fake sandbox strips the `timeout -k` wrapper
// macOS lacks.
//
//   pnpm exec tsx --test test/landing-requeue.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TicketState } from "../mod/hooks/run-record.ts";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merge passes process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { accountLanding, againLine, createHostGit, createRequeueRecord, landingLines, landingWork, newLandings, requeuedLine } = await import("../src/landing.ts");
const { notLandedComment } = await import("../src/burndown.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { landOnlyHead, recordHead, recordRun } = await import("../src/run.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Ctx = import("../src/landing.ts").LandContext;
type Landed = import("../src/landing.ts").Landed;
type Waiting = import("../src/landing.ts").Waiting;
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;
type StopCause = import("../src/schedule.ts").StopCause;
type Attempted = import("../src/schedule.ts").Attempted<Waiting, string>;
type Change = import("../src/schedule.ts").Change<Waiting, string>;
type Work = import("../src/schedule.ts").Work<Issue, Waiting, string>;

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
// A ticket's pipeline: the green branch it leaves, or nothing (it ended red, say).
type Pipeline = (issue: Issue, attempt: number) => Promise<Waiting | undefined>;

const newRecord = () => {
  const project = { root: join(TMP, `record${n++}`), name: "fixture" } as unknown as Project;
  const record = recordRun(project);
  removeAtExit();
  const written = () => JSON.parse(readFileSync(join(project.root, ".sandcastle/logs/run.json"), "utf8")).tickets ?? {};
  return { record, written };
};

/** A promise per ticket, resolved when the scheduler tells that ticket's ending: orders a test by events, not by sleeping. */
const endings = () => {
  const told = new Map<string, () => void>();
  const at = new Map<string, Promise<void>>();
  const of = (id: string) => {
    if (!at.has(id)) at.set(id, new Promise<void>((resolve) => told.set(id, resolve)));
    return at.get(id)!;
  };
  return { of, tell: (c: Change) => void (c.kind === "ended" && (of(c.id), told.get(c.id)!())) };
};

/**
 * What the run is told and ends with, as burndown.ts reads it: the requeues and endings through the
 * record's side of a requeue (`createRequeueRecord`, the code burndown.ts calls), the Landings lists
 * from each landing ending (`accountLanding`) and the outcome lines from them (`landingLines`).
 */
const observe = (record: ReturnType<typeof recordRun>, onTell?: (c: Change) => void) => {
  const told: Change[] = [];
  const said: string[] = [];
  const dropped: string[] = [];
  const requeues = createRequeueRecord({ run: record, bookkeep: (_id, fn) => fn(), dropFirst: (id) => void dropped.push(id), ref: (id) => `#${id}`, say: (line) => void said.push(line) });
  const tell = (c: Change) => {
    told.push(c);
    if (c.kind === "requeued") requeues.requeued(c.id, c.again);
    if (c.kind === "ended") requeues.ended(c.id, c.ending);
    onTell?.(c);
  };
  const ended = () => told.flatMap((c) => (c.kind === "ended" ? [{ id: c.id, ending: c.ending }] : []));
  const lists = () => {
    const l = newLandings();
    for (const { ending: e } of ended()) if (e.kind === "landing") accountLanding(l, e.green, e.landed);
    return l;
  };
  return {
    told,
    said,
    dropped,
    requeues,
    tell,
    ended,
    lists,
    outcomes: () => landingLines(lists(), requeues.againNote),
    // Each outcome's line alone, as the status view shows it.
    lines: () => new Map([...landingLines(lists(), requeues.againNote)].map(([id, o]) => [id, o.text])),
    // "2: requeued after conflict with #1", for each "runs again in this run" line.
    sentBack: () => said.flatMap((line) => (/; its pipeline runs again in this run\.$/.test(line) ? [line.replace("; its pipeline runs again in this run.", "").replace(/^#(\d+): /, "$1: ")] : [])),
  };
};

/**
 * One run through the scheduler, with `pipeline` standing in for a ticket's sandbox pipeline behind
 * the attempt port and the real `landOne` behind the land port. `before` is the check burndown.ts
 * makes before a pipeline (the usage probe, the tracker), and may end the attempt there.
 */
const run = async (
  root: string,
  ids: string[],
  pipeline: Pipeline,
  gate: Ctx["gate"] = async () => GREEN,
  workers = 2,
  o: { before?: (issue: Issue, attempt: number) => Promise<Attempted | undefined>; onTell?: (c: Change) => void } = {},
) => {
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
  const attempts = new Map<string, number>();
  const seen = observe(record, o.onTell);
  const { endings, stop } = await createSchedule<Issue, Waiting, string>({ tickets: ids.map((id) => ({ id })) }).run({
    workers,
    ...landingWork(ctx),
    attempt: async (issue, { n }) => {
      const early = await o.before?.(issue, n);
      if (early) return early;
      attempts.set(issue.id, n);
      // As burndown.ts brackets a pipeline: its agent may commit to the branch, and the `.git` check then takes the tip.
      host.begin(`agent/issue-${issue.id}`);
      const out = await pipeline(issue, n);
      await host.settle(`agent/issue-${issue.id}`, `after #${issue.id}`);
      return out ? { kind: "green", green: out } : { kind: "pipeline", outcome: "red" };
    },
    tell: seen.tell,
  });
  // Each landing ending in the order it came, with what a second conflict or red was held as.
  const final = seen.ended().flatMap(({ id, ending: e }) => (e.kind === "landing" ? [{ issue: id, landed: e.landed, line: seen.requeues.againNote.get(id) }] : []));
  const stopped = seen.ended().flatMap(({ id, ending: e }) => (e.kind === "stopped" && e.finished ? [id] : []));
  return { final, sentBack: seen.sentBack(), stopped, states: written(), calls, host, stop, attempts, endings, told: seen.told, lists: seen.lists(), lines: seen.lines() };
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

// 1 lands; then 4's attempt reports a cause that stops the run while 2 and 3 are green already: 2
// meets 1 on shared.txt at landing, and 3, which changes a file of its own, reaches landing after
// 2. Ordered by events: 4 reports once 1 has merged, 2's pipeline ends once 4's ending is told
// (the cause is in the stop state by then), and 3's once 2's ending is.
const stopMidRun = async (report: Attempted) => {
  const root = makeRepo({ 1: { "shared.txt": "one\n" }, 2: { "shared.txt": "two\n" }, 3: { "c.txt": "three\n" } });
  const told = endings();
  const pipeline: Pipeline = async (issue) => {
    if (issue.id === "2") await told.of("4");
    if (issue.id === "3") await told.of("2");
    return outcome(root, issue.id);
  };
  const before = async (issue: Issue) => {
    if (issue.id !== "4") return undefined;
    while (!mergeOrder(root).includes("1")) await new Promise((r) => setTimeout(r, 5));
    return report;
  };
  return { root, r: await run(root, ["1", "2", "3", "4"], pipeline, async () => GREEN, 4, { before, onTell: told.tell }) };
};

test("after a usage stop a conflict at landing is not requeued, and a green ticket still lands", async () => {
  const usage: StopCause = { kind: "usage limit", line: "usage 97% of the 5-hour window" };
  const { root, r } = await stopMidRun({ kind: "not begun", why: usage });
  // One attempt, no requeue told, a conflicted ending.
  assert.equal(r.told.some((c) => c.kind === "requeued"), false, "no requeue told");
  assert.deepEqual(r.sentBack, [], "no 'runs again in this run' line");
  assert.equal(r.attempts.get("2"), 1);
  assert.deepEqual(r.endings.get("2"), { kind: "landing", green: outcome(root, "2"), landed: { kind: "conflict", files: ["shared.txt"], with: ["1"] }, attempts: 1 });
  assert.deepEqual(r.final.map((f) => [f.issue, f.landed.kind]), [["1", "merged"], ["2", "conflict"], ["3", "merged"]]);
  assert.equal(r.states["2"].state, "conflict");
  assert.equal(r.states["2"].requeued ?? null, null, "no requeue recorded");
  assert.deepEqual(r.lists.conflicted.map((c) => [c.issue, c.with]), [["2", ["1"]]]);
  assert.equal(r.lines.get("2"), "merge conflict: with #1: shared.txt");
  assert.deepEqual(r.stopped, []);
  // A limit still lands what is green.
  assert.deepEqual(mergeOrder(root), ["1", "3"]);
  assert.deepEqual(r.stop.causes, [usage]);
  assert.deepEqual(r.endings.get("4"), { kind: "not begun", why: usage });
});

test("after a .git change nothing more lands: the conflicting and the green ticket both end stopped", async () => {
  const cause: StopCause = { kind: "tampered", error: new Error("STOPPED after #4: main moved while sandboxes ran") };
  const { root, r } = await stopMidRun({ kind: "stopped", cause });
  assert.equal(r.told.some((c) => c.kind === "requeued"), false);
  assert.deepEqual(r.sentBack, []);
  assert.equal(r.attempts.get("2"), 1);
  assert.deepEqual(r.final.map((f) => [f.issue, f.landed.kind]), [["1", "merged"]]);
  assert.deepEqual(r.stopped, ["2", "3"]);
  for (const id of ["2", "3"]) assert.deepEqual(r.endings.get(id), { kind: "stopped", cause, finished: true, green: outcome(root, id) });
  assert.equal(r.states["2"]?.requeued ?? null, null);
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
  assert.deepEqual([...r.endings.keys()].sort(), ["1", "2"]);
  // No tickets at all: the run ends at once.
  const empty = await createSchedule<Issue, Waiting, string>({ tickets: [] }).run(fakeWork({}, {}));
  assert.equal(empty.endings.size, 0);
});

// ---------------------------------------------------------------------------
// The scheduler over made-up landings: the requeue-once rule, and what the record's side of a
// requeue (createRequeueRecord) writes to a run record as it is told.
// ---------------------------------------------------------------------------

const waiting = (id: string): Waiting => ({ issue: id, branch: `agent/issue-${id}`, status: "green", commits: 1, repairs: 0 });

/**
 * Fake work: each attempt is green unless `attempt` says otherwise, and each ticket's k-th landing
 * is `lands[id][k]` (merged past the end), written to `record` first as landOne writes its state.
 */
type Made = { landed: Landed; as?: [TicketState, string] };
const fakeWork = (
  lands: Record<string, Made[]>,
  o: { record?: ReturnType<typeof recordRun>; attempt?: Work["attempt"]; tell?: (c: Change) => void; workers?: number; landFirst?: (g: Waiting) => Promise<void> },
): Work => {
  const k = new Map<string, number>();
  return {
    workers: o.workers ?? 2,
    attempt: o.attempt ?? (async (t) => ({ kind: "green", green: waiting(t.id) })),
    land: async (g) => {
      await o.landFirst?.(g);
      const at = k.get(g.issue) ?? 0;
      k.set(g.issue, at + 1);
      const made = lands[g.issue]?.[at] ?? { landed: { kind: "merged" } };
      if (made.as) o.record?.ticket(g.issue, { state: made.as[0], note: made.as[1] });
      return made.landed;
    },
    host: { check: async () => {}, failed: undefined },
    tell: o.tell ?? (() => {}),
  };
};
const conflictWith1: Made = { landed: { kind: "conflict", files: ["shared.txt"], with: ["1"] }, as: ["conflict", "with #1: shared.txt"] };
const redWith1: Made = { landed: { kind: "red", with: ["1"], gates: ["test"] }, as: ["red", "test red with #1"] };

test("the requeue-once rule: a first conflict or red is requeued, a second is final, and anything else stands", async () => {
  const lands: Record<string, Made[]> = {
    2: [conflictWith1, conflictWith1],
    3: [redWith1, { landed: { kind: "merged" } }],
    4: [{ landed: { kind: "merged" } }],
    5: [{ landed: { kind: "not-landed", reason: "ENOSPC" } }],
    6: [{ landed: { kind: "held", paths: [".github/workflows/ci.yml"], reason: "human merge" } }],
  };
  const told: Change[] = [];
  const n: Record<string, number[]> = {};
  const { endings } = await createSchedule<Issue, Waiting, string>({ tickets: ["2", "3", "4", "5", "6"].map((id) => ({ id })) }).run(
    fakeWork(lands, {
      tell: (c) => void told.push(c),
      attempt: async (t, at) => {
        (n[t.id] ??= []).push(at.n);
        if (at.n === 2) assert.ok(at.again, "a second attempt carries what the first collided with");
        return { kind: "green", green: waiting(t.id) };
      },
    }),
  );
  assert.deepEqual(
    told.flatMap((c) => (c.kind === "requeued" ? [[c.id, c.again]] : [])),
    [
      ["2", { kind: "conflict", with: ["1"] }],
      ["3", { kind: "red", with: ["1"] }],
    ],
  );
  assert.deepEqual(n, { 2: [1, 2], 3: [1, 2], 4: [1], 5: [1], 6: [1] });
  assert.deepEqual(
    Object.fromEntries([...endings].map(([id, e]) => [id, e.kind === "landing" ? [e.landed.kind, e.attempts] : e.kind])),
    { 2: ["conflict", 2], 3: ["merged", 2], 4: ["merged", 1], 5: ["not-landed", 1], 6: ["held", 1] },
  );
  assert.equal(requeuedLine("red", []), "requeued after red");
  assert.equal(requeuedLine("conflict", ["1"]), "requeued after conflict with #1");
  assert.equal(againLine("conflict", ["1", "3"]), "conflicted again with #1, #3 after a requeue");
});

/** One run over made-up landings, with a run record and the record's side of a requeue observing it; `o` may read both as the run goes. */
type Seen = { written: () => Record<string, Record<string, unknown>>; seen: ReturnType<typeof observe> };
const settle = async (ids: string[], lands: Record<string, Made[]>, o: (s: Seen) => { attempt?: Work["attempt"]; onTell?: (c: Change) => void; workers?: number } = () => ({})) => {
  const { record, written } = newRecord();
  let opts: ReturnType<typeof o> = {};
  const seen = observe(record, (c) => opts.onTell?.(c));
  opts = o({ written, seen });
  const r = await createSchedule<Issue, Waiting, string>({ tickets: ids.map((id) => ({ id })) }).run(fakeWork(lands, { record, attempt: opts.attempt, tell: seen.tell, workers: opts.workers }));
  return { ...r, seen, written };
};

test("conflict, requeued, merged: the second landing is the outcome and the status view is not left prefixed", async () => {
  let atSecond: { record: Record<string, unknown>; requeuedAs?: string; ended: string[] } | undefined;
  const r = await settle(["2"], { 2: [conflictWith1, { landed: { kind: "merged" }, as: ["merged", "merged"] }] }, ({ written, seen }) => ({
    attempt: async (t, { n }) => {
      // As the second attempt begins: queued, with the line its setup carries, and nothing accounted.
      if (n === 2) atSecond = { record: written()["2"], requeuedAs: seen.requeues.requeuedAs.get("2"), ended: seen.ended().map((e) => e.id) };
      return { kind: "green", green: waiting(t.id) };
    },
  }));
  assert.ok(atSecond, "a second attempt began");
  assert.deepEqual(r.seen.said, ["#2: requeued after conflict with #1; its pipeline runs again in this run."]);
  assert.deepEqual(atSecond.record, { ...atSecond.record, state: "queued", note: "requeued after conflict with #1", requeued: "requeued after conflict with #1" });
  assert.equal(atSecond.requeuedAs, "requeued after conflict with #1");
  assert.deepEqual(atSecond.ended, [], "nothing is accounted while the second attempt is to come");
  assert.deepEqual(r.seen.lists().merged, ["2"]);
  assert.deepEqual(r.seen.lists().conflicted, []);
  assert.equal(r.seen.lines().get("2"), "merged");
});

test("conflict, requeued, conflict again: the outcome keeps the files, and the comment names both attempts' tickets", async () => {
  const again: Made = { landed: { kind: "conflict", files: ["other.txt", "more.txt"], with: ["3"] }, as: ["conflict", "with #3: other.txt, more.txt"] };
  const r = await settle(["2"], { 2: [conflictWith1, again] });
  assert.equal(r.seen.lines().get("2"), "merge conflict: conflicted again with #1, #3 after a requeue: other.txt, more.txt");
  assert.equal(r.seen.outcomes().get("2")?.kind, "conflict");
  assert.equal(r.written()["2"].note, "conflicted again with #1, #3 after a requeue: other.txt, more.txt");
  assert.equal(r.written()["2"].state, "conflict");
  const lists = r.seen.lists();
  assert.deepEqual(lists.conflicted.map((c) => [c.issue, c.with, c.files]), [["2", ["1", "3"], ["other.txt", "more.txt"]]]);
  const c = lists.conflicted[0];
  const comment = notLandedComment(undefined, { branch: c.branch, base: "main", files: c.files, with: c.with })!;
  assert.match(comment, /conflicted \(with #1, #3: other\.txt, more\.txt\)/);
});

test("red, requeued, red again: no doubled 'red', and the comment names both attempts' tickets", async () => {
  let requeued: unknown;
  const r = await settle(["2"], { 2: [redWith1, { landed: { kind: "red", with: ["3"], gates: ["test"] }, as: ["red", "test red with #3"] }] }, ({ written }) => ({
    attempt: async (t, { n }) => {
      if (n === 2) requeued = written()["2"].requeued;
      return { kind: "green", green: waiting(t.id) };
    },
  }));
  assert.equal(requeued, "requeued after red with #1");
  assert.equal(r.seen.lines().get("2"), "red again with #1, #3 after a requeue");
  // Red at landing again is still `red`, the kind every reader decides on, whatever the line says.
  assert.equal(r.seen.outcomes().get("2")?.kind, "red");
  assert.equal(r.written()["2"].note, "red again with #1, #3 after a requeue");
  const lists = r.seen.lists();
  assert.deepEqual(lists.redMerged, [{ issue: "2", branch: "agent/issue-2", with: ["1", "3"], gates: ["test"] }]);
  const red = lists.redMerged[0];
  assert.match(notLandedComment(undefined, undefined, { branch: red.branch, base: "main", with: red.with, gates: red.gates })!, /since this branch forked: #1, #3/);
});

test("a first red or conflict that is not requeued keeps the plain outcome lines", async () => {
  // 1 finds a usage limit before it begins; 2 and 3, already running, land after it and are not requeued.
  let found!: () => void;
  const limit = new Promise<void>((resolve) => (found = resolve));
  const usage: StopCause = { kind: "usage limit", line: "usage 97% of the 5-hour window" };
  const r = await settle(["1", "2", "3"], { 2: [redWith1], 3: [{ landed: { kind: "conflict", files: ["a.txt", "b.txt", "c.txt", "d.txt"], with: ["1"] } }] }, () => ({
    workers: 3,
    attempt: async (t) => {
      if (t.id === "1") {
        found();
        return { kind: "not begun", why: usage };
      }
      await limit;
      return { kind: "green", green: waiting(t.id) };
    },
  }));
  assert.equal(r.seen.lines().get("2"), "red when merged with #1");
  assert.equal(r.seen.lines().get("3"), "merge conflict: with #1: a.txt, b.txt, c.txt and 1 more");
  assert.deepEqual([r.seen.outcomes().get("2"), r.seen.outcomes().get("3")?.kind, r.seen.outcomes().get("3")?.with], [{ kind: "red", with: ["1"], text: "red when merged with #1" }, "conflict", ["1"]]);
  assert.deepEqual(r.seen.said, []);
});

test("requeued, then withdrawn before the second start: withdrawn, not green, and the first pipeline's entry dropped", async () => {
  const withdrawn: Attempted = { kind: "not begun", why: { kind: "withdrawn", reason: "closed during the run" } };
  const r = await settle(["2", "9"], { 2: [conflictWith1] }, () => ({
    // 9 is withdrawn before its first attempt: never sent back, so nothing to drop and no landing to account.
    attempt: async (t, { n }) => (n === 2 || t.id === "9" ? withdrawn : { kind: "green", green: waiting(t.id) }),
  }));
  assert.deepEqual(r.seen.dropped, ["2"]);
  const lists = r.seen.lists();
  assert.deepEqual(lists.withdrawn, [{ issue: "2", reason: "closed during the run" }]);
  assert.deepEqual(lists.conflicted, [], "its first landing does not stand: it was withdrawn since");
  assert.equal(r.seen.lines().get("2"), "withdrawn: closed during the run");
  assert.equal(r.written()["2"].state, "withdrawn");
  assert.equal(r.written()["2"].note, "closed - not started");
  assert.equal(r.written()["2"].requeued, null);
  assert.equal(r.seen.requeues.requeuedAs.has("2"), false);
  assert.deepEqual(r.endings.get("9"), { kind: "not begun", why: { kind: "withdrawn", reason: "closed during the run" } });
  assert.deepEqual(lists.withdrawn.map((w) => w.issue), ["2"]);
});

test("requeued, then the run stops: the first outcome stands, and the status view is no longer told it was requeued", async () => {
  // Both are sent back; 2's second attempt then finds a usage limit, and 3's never begins.
  let bothBack!: () => void;
  const back = new Promise<void>((resolve) => (bothBack = resolve));
  let requeued: unknown;
  const usage: StopCause = { kind: "usage limit", line: "usage 97% of the 5-hour window" };
  const r = await settle(["2", "3"], { 2: [conflictWith1], 3: [redWith1] }, ({ written, seen }) => ({
    onTell: (c) => {
      if (c.kind === "requeued" && seen.told.filter((x) => x.kind === "requeued").length === 2) bothBack();
    },
    attempt: async (t, { n }) => {
      if (n === 1) return { kind: "green", green: waiting(t.id) };
      await back;
      requeued = written()["2"].requeued;
      return { kind: "not begun", why: usage };
    },
  }));
  assert.equal(requeued, "requeued after conflict with #1");
  // Each has one ending: its first landing.
  assert.deepEqual(r.seen.ended().map((e) => e.id).sort(), ["2", "3"]);
  for (const id of ["2", "3"]) {
    const e = r.endings.get(id);
    assert.equal(e?.kind === "landing" && e.attempts, 1);
  }
  const lists = r.seen.lists();
  assert.deepEqual(lists.conflicted.map((c) => c.issue), ["2"]);
  assert.deepEqual(lists.redMerged.map((red) => red.issue), ["3"]);
  assert.equal(r.seen.lines().get("2"), "merge conflict: with #1: shared.txt");
  assert.equal(r.seen.lines().get("3"), "red when merged with #1");
  assert.deepEqual([r.written()["2"].state, r.written()["2"].note, r.written()["2"].requeued], ["conflict", "with #1: shared.txt", null]);
  assert.deepEqual([r.written()["3"].state, r.written()["3"].note, r.written()["3"].requeued], ["red", "test red with #1", null]);
  assert.deepEqual(r.seen.dropped, []);
});

test("a closed queue is checked before a requeue: the normal conflict outcome, nothing told or recorded as requeued", async () => {
  // Reading 2's files again as 1's pipeline ends fails, so the pipelines close while 2 is landing:
  // 2's conflict has nowhere to go back to.
  const { record, written } = newRecord();
  const seen = observe(record);
  let landing!: () => void;
  const isLanding = new Promise<void>((resolve) => (landing = resolve));
  let failed!: () => void;
  const hasFailed = new Promise<void>((resolve) => (failed = resolve));
  const work = fakeWork(
    { 2: [conflictWith1] },
    {
      record,
      tell: seen.tell,
      landFirst: async () => {
        landing();
        await hasFailed;
        // Past the microtasks that close the queues after the failure.
        await new Promise((r) => setTimeout(r, 0));
      },
      attempt: async (t) => {
        if (t.id === "2") return { kind: "green", green: waiting(t.id) };
        await isLanding;
        return { kind: "pipeline", outcome: "red" };
      },
    },
  );
  const boom = new Error("git diff failed");
  let ended = false;
  const run = createSchedule<Issue, Waiting, string>({
    tickets: [{ id: "1" }, { id: "2" }],
    files: {
      of: () => ({ all: [], unmergeable: [] }),
      refresh: (t, files) => {
        if (!ended) return files;
        failed();
        throw boom;
      },
    },
  }).run({
    ...work,
    tell: (c) => {
      if (c.kind === "ended" && c.id === "1") ended = true;
      work.tell(c);
    },
  });
  await assert.rejects(run, boom);
  assert.equal(seen.told.some((c) => c.kind === "requeued"), false);
  assert.deepEqual(seen.said, []);
  assert.equal(seen.requeues.requeuedAs.has("2"), false);
  const two = seen.ended().find((e) => e.id === "2")?.ending;
  assert.deepEqual(two, { kind: "landing", green: waiting("2"), landed: conflictWith1.landed, attempts: 1 });
  assert.deepEqual(seen.lists().conflicted.map((c) => [c.issue, c.with]), [["2", ["1"]]]);
  assert.equal(seen.lines().get("2"), "merge conflict: with #1: shared.txt");
  // Nothing to undo: no requeue was ever written.
  assert.deepEqual([written()["2"].state, written()["2"].note, written()["2"].requeued ?? null], ["conflict", "with #1: shared.txt", null]);
});

test("a requeue is told, and recorded, before the ticket is queued again", async () => {
  // 1 is still running when 2 is sent back, so its `last()` reads the pipeline queue: true while
  // nothing is queued, false once 2 is. Read as the requeue is told, and again just after.
  const { record } = newRecord();
  const order: string[] = [];
  const spy = { ...record, ticket: (id: string, f: Parameters<typeof record.ticket>[1]) => (order.push(`write ${f.state}`), record.ticket(id, f)) };
  const seen = observe(spy as typeof record);
  let last!: () => boolean;
  let sentBack!: () => void;
  const isBack = new Promise<void>((resolve) => (sentBack = resolve));
  await createSchedule<Issue, Waiting, string>({ tickets: [{ id: "1" }, { id: "2" }] }).run(
    fakeWork(
      { 2: [conflictWith1] },
      {
        tell: (c) => {
          if (c.kind !== "requeued") return seen.tell(c);
          order.push(`told, queued: ${!last()}`);
          seen.tell(c);
          queueMicrotask(() => order.push(`after, queued: ${!last()}`));
          sentBack();
        },
        attempt: async (t, at) => {
          if (t.id === "1") {
            last = at.last;
            await isBack;
          }
          return { kind: "green", green: waiting(t.id) };
        },
      },
    ),
  );
  assert.deepEqual(order, ["told, queued: false", "write queued", "after, queued: true"]);
});
