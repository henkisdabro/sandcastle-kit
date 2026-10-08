// A ticket whose blocker is in the same run starts in that run, once the blocker has landed and
// closed: the release of dependants inside `createSchedule` (src/schedule.ts), driven through
// `createSchedule(plan).run(work)` with the blockers port the burndown passes (openBlockersNow in
// src/blockers.ts). Fake attempts that branch from the base as it is when they start, the real
// land port (`landOne`) on a temp repo, a fake tracker and a `gh` shim on PATH that reads each
// blocker's state from a file the tracker's close writes: no Docker, no network.
//
// The shim is a POSIX sh script and every path comes from os.tmpdir() and node:path, so the test
// runs the same on Linux and macOS (no GNU-only flag anywhere; PATH is joined with path.delimiter).
//
//   pnpm test:file test/release-dependants.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-release-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// `gh api repos/{owner}/{repo}/issues/<id> --jq ...` answers "<state> <reason>" from a file.
const SHIM = join(TMP, "bin");
const STATE = join(TMP, "gh-state");
mkdirSync(SHIM);
mkdirSync(STATE);
writeFileSync(join(SHIM, "gh"), `#!/bin/sh\nid="\${2##*/}"\nif [ -e "${STATE}/closed-$id" ]; then echo "closed "; else echo "open "; fi\n`);
chmodSync(join(SHIM, "gh"), 0o755);
process.env.PATH = `${SHIM}${delimiter}${process.env.PATH}`;

const { blockedNote, blockerTicket, openBlockers, openBlockersNow, blockerResolver } = await import("../src/blockers.ts");
const { createHostGit, landingWork } = await import("../src/landing.ts");
const { createHoldRecord, refusedRecord } = await import("../src/burndown.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { createSchedule } = await import("../src/schedule.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Blocker = import("../src/blockers.ts").Blocker;
type Project = import("../src/config.ts").Project;
type Ctx = import("../src/landing.ts").LandContext;
type Waiting = import("../src/landing.ts").Waiting;
type Ticket = import("../src/tracker.ts").Ticket;

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const commitFile = (root: string, file: string, text: string, message: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  git(root, "add", file);
  git(root, "commit", "-q", "-m", message);
};

let n = 0;
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commitFile(root, "shared.txt", "start\n", "start");
  return root;
};

const ticket = (id: string, blockedBy: string[] = [], extra: Partial<Ticket> = {}): Ticket => ({
  id,
  title: `ticket ${id}`,
  body: blockedBy.length ? `Blocked by ${blockedBy.map((b) => `#${b}`).join(", ")}` : "",
  comments: [],
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

type Run = {
  root: string;
  events: string[];
  states: Record<string, { state?: string; note?: string | null }>;
  history: Record<string, string[]>;
  started: string[];
  landed: string[];
  said: string[];
};

/**
 * Drives the scheduler as burndown.ts does: the blockers read at the start, `createSchedule` with
 * the held tickets and the real blockers port (`openBlockersNow`), the real land port over a temp
 * repo, and the burndown's wording of what `tell` says - a ticket that starts (`createHoldRecord`),
 * what a held one waits for now (`blockedNote`), a requeue, a refused label. `pipeline` is the fake
 * attempt: it branches from the base as it is when the ticket starts (`attempt` is 2 for a
 * requeued ticket), and returns what to do with the branch.
 */
const runWith = async (
  tickets: Ticket[],
  opts: {
    pipeline?: (t: Ticket, root: string, attempt: number) => Promise<"green" | "red">;
    badLabel?: Record<string, string>;
    /** As a ticket starts. */
    onStart?: (id: string, run: Run) => void;
    /** Tickets whose attempt finds a usage limit as it would begin: the run starts nothing more. */
    usageLimit?: string[];
    /** Time a ticket works on after its branch is made, outside the host lock. */
    delay?: Record<string, number>;
    /** Time before a ticket makes its branch, so it forks from a base that has moved. */
    lead?: Record<string, number>;
    dryRun?: boolean;
    closeFails?: Set<string>;
  } = {},
): Promise<Run> => {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE);
  const root = makeRepo();
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [], tracker: fakeTracker() } as unknown as Project;
  const run: Run = { root, events: [], states: {}, history: {}, started: [], landed: [], said: [] };
  const record = {
    ticket: (id: string, fields: { state?: string; note?: string | null }) => {
      run.states[id] = { ...run.states[id], ...fields };
      if (typeof fields.state === "string") (run.history[id] ??= []).push(fields.state);
    },
    update: () => {},
  };
  const tracker = {
    kind: "github",
    ref: (id: string) => `#${id}`,
    declaredBlockers: () => [] as string[],
    close: (id: string) => {
      if (opts.closeFails?.has(id)) throw new Error("gh: HTTP 502");
      writeFileSync(join(STATE, `closed-${id}`), "");
      run.events.push(`close ${id}`);
    },
    comment: () => {},
    hold: () => {},
  } as unknown as Ctx["tracker"];
  const say = (line: string) => void run.said.push(line);

  // The start of the run, as burndown.ts does it.
  const queued = tickets.map((t) => t.id);
  const resolve = blockerResolver(project, tracker, new Set(queued));
  const open = await Promise.all(tickets.map((t) => openBlockers(project, tracker, resolve, t)));
  const held = new Map(tickets.flatMap((t, at) => (open[at].length ? [[t.id, { ticket: t, on: open[at] }] as const] : [])));
  const waiting = tickets.flatMap((t) => (held.has(t.id) ? [{ issue: t.id, on: held.get(t.id)!.on.map((b) => `#${b.id}`) }] : []));
  const ready = tickets.filter((t) => !held.has(t.id));
  const schedule = createSchedule<Ticket, Waiting, "red", Blocker>({
    tickets: ready,
    blockers: { held: [...held.values()], ticketOf: blockerTicket, ...(opts.dryRun ? {} : { open: openBlockersNow(project, tracker, queued) }) },
    checkLabel: (t) => opts.badLabel?.[t.id],
  });
  const inRun = new Set(schedule.start.map((c) => c.ticket.id));
  for (const [id, h] of held) record.ticket(id, { state: "blocked", note: blockedNote(h.on, inRun) });
  for (const t of ready) record.ticket(t.id, { state: "queued" });

  const host = createHostGit(project, gitFingerprint(project));
  const ctx: Ctx = {
    project,
    tracker,
    base: "main",
    gateNames: "test",
    reports: new Map(),
    run: record,
    dryRun: opts.dryRun ?? false,
    opener: opener(root),
    withdrawal: () => undefined,
    host,
    gate: async () => ({ gates: [{ name: "test", pass: true }], failures: [] }),
    landed: new Map(),
  };
  const holds = createHoldRecord({ waiting, ref: tracker.ref, say });

  const fake =
    opts.pipeline ??
    (async (t: Ticket, repo: string) => {
      git(repo, "checkout", "-q", "-b", `agent/issue-${t.id}`, "main");
      commitFile(repo, `${t.id}.txt`, `${t.id}\n`, `work on ${t.id}`);
      git(repo, "checkout", "-q", "main");
      return "green" as const;
    });
  await schedule.run({
    workers: 2,
    ...landingWork(ctx),
    attempt: async (t, at) => {
      if (opts.usageLimit?.includes(t.id)) return { kind: "not begun", why: { kind: "usage limit", line: "usage 97% of the 5-hour window" } };
      run.started.push(t.id);
      run.events.push(`start ${t.id}`);
      opts.onStart?.(t.id, run);
      record.ticket(t.id, { state: "setup" });
      // Branches are made one at a time: they share one working tree.
      await sleep(opts.lead?.[t.id] ?? 0);
      const result = await host.exclusive(() => fake(t, root, at.n));
      await sleep(opts.delay?.[t.id] ?? 0);
      if (result !== "green") return { kind: "pipeline", outcome: "red" };
      return { kind: "green", green: { issue: t.id, branch: `agent/issue-${t.id}`, status: "green", commits: 1, repairs: 0, head: git(root, "rev-parse", `agent/issue-${t.id}`) } };
    },
    tell: (c) => {
      switch (c.kind) {
        case "requeued":
          run.events.push(`requeued ${c.id}`);
          record.ticket(c.id, { state: "queued", note: `requeued after ${c.again.kind}` });
          return;
        case "ended": {
          const e = c.ending;
          if (e.kind === "landing") {
            if (e.landed.kind === "merged" || e.landed.kind === "close-failed") run.landed.push(c.id);
            run.events.push(`settled ${c.id} ${e.landed.kind}`);
          } else if (e.kind === "not begun" && e.why.kind === "refused label") {
            say(`  ${e.why.reason}`);
            record.ticket(c.id, refusedRecord(e.why.reason));
          }
          return;
        }
        case "blocked":
          record.ticket(c.id, { note: blockedNote(c.on, new Set(c.inFlight), new Set(c.landed), new Map(c.ended.map((id) => [id, "not landed"]))) });
          return;
        case "unreleased":
          say(`#${c.id}: could not start the tickets that wait for it`);
          return;
        case "started":
        case "waits":
        case "next run":
          holds.tell(record, c);
          return;
      }
    },
  });
  return run;
};

const mergeOrder = (root: string) =>
  git(root, "log", "--first-parent", "--reverse", "--format=%s", "main")
    .split("\n")
    .flatMap((s) => /^Merge agent\/issue-(\d+) /.exec(s)?.[1] ?? []);

test("a chain of depth 4 lands in one run, in order", async () => {
  const run = await runWith([ticket("1"), ticket("2", ["1"]), ticket("3", ["2"]), ticket("4", ["3"])]);
  assert.deepEqual(run.started, ["1", "2", "3", "4"]);
  assert.deepEqual(mergeOrder(run.root), ["1", "2", "3", "4"]);
  // Each started only once the one before it had landed and been closed.
  for (const [blocker, dependant] of [["1", "2"], ["2", "3"], ["3", "4"]]) {
    assert.ok(run.events.indexOf(`close ${blocker}`) < run.events.indexOf(`start ${dependant}`), `${dependant} started before ${blocker} closed: ${run.events.join(" | ")}`);
  }
  // blocked -> queued -> running (setup is its first running state).
  assert.deepEqual(run.history["3"].slice(0, 3), ["blocked", "queued", "setup"]);
  // A dependant's branch holds its blocker's work: it forked from the base the blocker landed on.
  assert.equal(git(run.root, "show", "main:1.txt"), "1");
});

test("the note at the start names the blocker and says it lands in this run", async () => {
  let note: string | null | undefined;
  await runWith([ticket("1"), ticket("2", ["1"])], { onStart: (id, run) => void (id === "1" && (note = run.states["2"]?.note)) });
  assert.equal(note, "waits for #1 (lands this run)");
});

test("a diamond releases its dependant after the second blocker, not the first", async () => {
  // 2 is slow, and branches after 1 has landed: 3 must still wait for it.
  const run = await runWith([ticket("1"), ticket("2"), ticket("3", ["1", "2"])], { lead: { 2: 200 } });
  const at = (e: string) => run.events.indexOf(e);
  assert.ok(at("close 1") >= 0 && at("close 2") >= 0 && at("start 3") >= 0, run.events.join(" | "));
  assert.ok(at("close 1") < at("close 2"), "1 lands first");
  assert.ok(at("start 3") > at("close 2"), `3 started before its second blocker closed: ${run.events.join(" | ")}`);
  assert.deepEqual(mergeOrder(run.root).sort(), ["1", "2", "3"]);
});

// 9 and 1 both change shared.txt from the same start, and 9 lands first (1 works on after
// branching), so 1's gated merge in its sandbox conflicts.
const sharedEdit = (resolve: boolean) => async (t: Ticket, repo: string, attempt: number) => {
  if (attempt === 1) {
    git(repo, "checkout", "-q", "-b", `agent/issue-${t.id}`, "main");
    commitFile(repo, "shared.txt", `${t.id}\n`, `work on ${t.id}`);
  } else {
    // The second attempt merges the base in, as the land-only path's resolver does: its own side wins.
    git(repo, "checkout", "-q", `agent/issue-${t.id}`);
    if (resolve) git(repo, "merge", "-q", "-X", "ours", "-m", "merge main", "main");
  }
  git(repo, "checkout", "-q", "main");
  return "green" as const;
};

test("a blocker that conflicts at landing is requeued, lands on its second attempt, and releases its dependant", async () => {
  const run = await runWith([ticket("9"), ticket("1"), ticket("2", ["1"])], { pipeline: sharedEdit(true), delay: { 1: 150 } });
  const at = (e: string) => run.events.indexOf(e);
  assert.ok(at("requeued 1") >= 0, `1 was not requeued: ${run.events.join(" | ")}`);
  assert.ok(at("close 1") > at("requeued 1") && at("start 2") > at("close 1"), `2 started before 1 landed: ${run.events.join(" | ")}`);
  assert.deepEqual(mergeOrder(run.root), ["9", "1", "2"]);
  assert.deepEqual(run.started, ["9", "1", "1", "2"]);
});

test("a blocker that conflicts twice releases nothing, and the run still ends", async () => {
  // The second attempt does not merge the base in, so it conflicts again: final for this run.
  const run = await runWith([ticket("9"), ticket("1"), ticket("2", ["1"])], { pipeline: sharedEdit(false), delay: { 1: 150 } });
  assert.ok(!run.started.includes("2"), `2 started: ${run.events.join(" | ")}`);
  assert.deepEqual(mergeOrder(run.root), ["9"]);
  assert.equal(run.states["2"].state, "blocked");
  assert.equal(run.states["2"].note, "waits for #1 (not landed)");
});

test("a dependant with a blocker outside the run stays held, with the note", async () => {
  const run = await runWith([ticket("1"), ticket("2", ["1", "50"]), ticket("3", ["50"])]);
  assert.deepEqual(run.started, ["1"]);
  assert.deepEqual(mergeOrder(run.root), ["1"]);
  assert.equal(run.states["2"].state, "blocked");
  // 50 was never this run's. 2 is not one of the run's candidates (it waits on 50 too), so its
  // blockers are not read again as 1 lands: its note is the start's.
  assert.match(run.states["2"].note ?? "", /#50 \(not in this run\)$/);
  assert.equal(run.states["3"].note, "waits for #50 (not in this run)");
});

test("a ticket queued mid-run is not started", async () => {
  const late = ticket("7", ["1"]);
  const all = [ticket("1"), ticket("2", ["1"])];
  const run = await runWith(all, {
    // 7 appears in the queue while 1 works; the run's candidate set was read at the start.
    onStart: (id) => {
      if (id === "1") all.push(late);
    },
  });
  assert.deepEqual(run.started, ["1", "2"]);
  assert.ok(!run.events.some((e) => e.includes(" 7")));
});

test("a run that has stopped releases nothing, and still ends", async () => {
  // 9's attempt finds a usage limit while 1 works: 1 still lands, green before the stop.
  const run = await runWith([ticket("1"), ticket("9"), ticket("2", ["1"])], { usageLimit: ["9"], delay: { 1: 100 } });
  assert.deepEqual(run.started, ["1"]);
  assert.deepEqual(mergeOrder(run.root), ["1"]);
  assert.equal(run.states["2"].state, "blocked");
});

test("a dry run releases nothing: nothing lands", async () => {
  const { result: run } = await quietly(() => runWith([ticket("1"), ticket("2", ["1"])], { dryRun: true }));
  assert.deepEqual(run.started, ["1"]);
  assert.deepEqual(run.landed, []);
});

test("a ticket whose close failed still releases its dependant: landing is the run's own fact", async () => {
  const run = await runWith([ticket("1"), ticket("2", ["1"])], { closeFails: new Set(["1"]) });
  assert.deepEqual(run.landed, ["1", "2"]);
  assert.deepEqual(run.started, ["1", "2"]);
  assert.deepEqual(mergeOrder(run.root), ["1", "2"]);
});

test("a red ticket releases nothing", async () => {
  const run = await runWith([ticket("1"), ticket("2", ["1"])], { pipeline: async () => "red" });
  assert.deepEqual(run.started, ["1"]);
  assert.equal(run.states["2"].state, "blocked");
  assert.equal(run.states["2"].note, "waits for #1 (not landed)");
});

test("a bad label on a released ticket holds that ticket, never the run", async () => {
  const run = await runWith([ticket("1"), ticket("2", ["1"]), ticket("3", ["1"])], { badLabel: { 2: 'NOT STARTED: #2 has the label "effort:turbo" - fix it.' } });
  assert.deepEqual(run.started, ["1", "3"]);
  assert.equal(run.states["2"].state, "skipped");
  assert.match(run.states["2"].note ?? "", /^not started: #2 has the label/);
  assert.deepEqual(mergeOrder(run.root), ["1", "3"]);
});

test("a fresh resolver reads a landed blocker as closed, where the first one read it as open", async () => {
  const root = makeRepo();
  const project = { root, name: "fixture", baseBranch: "main", tracker: fakeTracker() } as unknown as Project;
  const tracker = { kind: "github", ref: (id: string) => `#${id}`, declaredBlockers: () => [] } as unknown as Ctx["tracker"];
  const t = ticket("2", ["1"]);
  const first = blockerResolver(project, tracker, new Set(["1", "2"]));
  assert.equal((await openBlockers(project, tracker, first, t)).length, 1);
  writeFileSync(join(STATE, "closed-1"), "");
  assert.equal((await openBlockers(project, tracker, first, t)).length, 1, "the cache keeps its first answer");
  assert.equal((await openBlockers(project, tracker, blockerResolver(project, tracker, new Set(["2"])), t)).length, 0);
  rmSync(join(STATE, "closed-1"));
});

test("only tickets whose every open blocker is in this run are candidates, transitively", () => {
  const b = (id: string, kind: "github" | "linear" = "github"): Blocker => ({ kind, id, state: "open" });
  const held = [
    { ticket: ticket("2"), on: [b("1")] },
    { ticket: ticket("3"), on: [b("2")] },
    { ticket: ticket("4"), on: [b("1"), b("50")] },
    { ticket: ticket("5"), on: [b("4")] },
    { ticket: ticket("6"), on: [b("ENG-1", "linear")] },
  ];
  const start = (ready: Ticket[]) => createSchedule<Ticket, Waiting, unknown, Blocker>({ tickets: ready, blockers: { held, ticketOf: blockerTicket } }).start;
  assert.deepEqual(start([ticket("1")]).map((c) => [c.ticket.id, c.wait]), [["1", undefined], ["2", "blockers"], ["3", "blockers"]]);
  assert.deepEqual(start([]), []);
});

test("blockedNote: in flight lands this run, anything else is not this run's", () => {
  const b = (id: string) => ({ kind: "github" as const, id, state: "open" as const });
  assert.equal(blockedNote([b("5")], new Set(["5"])), "waits for #5 (lands this run)");
  assert.equal(blockedNote([b("5")], new Set()), "waits for #5 (not in this run)");
  assert.equal(blockedNote([b("5"), b("6")], new Set(["5"])), "waits for #5 (lands this run), #6 (not in this run)");
});

test("the scheduler takes a released ticket and ends the run only when nothing started is left", async () => {
  const attempted: string[] = [];
  const asked: string[] = [];
  const { endings } = await createSchedule<{ id: string }, { issue: string }, unknown, string>({
    tickets: [{ id: "1" }],
    // 2 waits for 1; read again once 1 has landed, it waits for nothing.
    blockers: { held: [{ ticket: { id: "2" }, on: ["1"] }], ticketOf: (b) => b, open: async (ts) => (asked.push(...ts.map((t) => t.id)), ts.map(() => [])) },
  }).run({
    workers: 1,
    attempt: async (t) => (attempted.push(t.id), { kind: "green", green: { issue: t.id } }),
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  assert.deepEqual(attempted, ["1", "2"]);
  assert.deepEqual(asked, ["2"]);
  assert.deepEqual([endings.get("1")?.kind, endings.get("2")?.kind], ["landing", "landing"]);
});
