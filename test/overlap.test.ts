// Which tickets start together: the file hold, inside `createSchedule` (src/schedule.ts), driven
// through `createSchedule(plan).run(work)` with fake ports. Tickets that share a file git cannot merge
// (a lockfile, a minified blob) run one at a time; tickets that share a mergeable file start
// together and the start line names it. A ticket's files are its branch's changed files and its
// `Touches:` line. Real git in a temp repo and fake pipelines; no Docker, model calls or network.
//
// Paths come from os.tmpdir() and node:path, and git runs as `git` with arguments as an array, so
// the test runs the same on Linux and macOS.
//
//   pnpm exec tsx --test test/overlap.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Importing burndown.ts must not touch the real config or cache.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { branchFiles, createHoldRecord, refreshFiles, refusedRecord, ticketFiles } = await import("../src/burndown.ts");
const { createSchedule, fileShareLine, fileWaitNote } = await import("../src/schedule.ts");
type Ending<G, O> = import("../src/schedule.ts").Ending<G, O>;
type Project = import("../src/config.ts").Project;
type Ticket = import("../src/tracker.ts").Ticket;

// A minified bundle: well over 2000 bytes on one line, so every change touches the same line.
const MINIFIED = `${"var a=function(b){return b+1};".repeat(100)}\n`;

// A fresh repo on `main` with one commit, and helpers to branch and commit.
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-overlap-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  const commit = (files: string[], message: string, text = `${message}\n`) => {
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  // A branch off the current main that changes `files`, then back to main.
  const branch = (id: string, files: string[]) => {
    git("branch", `agent/issue-${id}`, "main");
    git("checkout", "-q", `agent/issue-${id}`);
    commit(files, `issue ${id}`);
    git("checkout", "-q", "main");
  };
  commit(["README.md"], "init");
  commit(["dist/app.min.js"], "add the bundle", MINIFIED);
  commit(["page.html", "pnpm-lock.yaml"], "add a page and a lockfile");
  const project = { root, name: "fixture", baseBranch: "main", generated: [], gates: [], setup: [] } as unknown as Project;
  return { root, git, commit, branch, project };
};

const ticket = (id: string, touches?: string): Ticket => ({ id, title: `ticket ${id}`, body: touches ? `Do it.\n\nTouches: ${touches}\n` : "Do it.", comments: [] });
const ref = (id: string) => `#${id}`;

type Flow = {
  events: string[];
  said: string[];
  notes: Record<string, string | null | undefined>;
  noted: string[];
  peak: number;
  started: string[];
  waiting: { issue: string; on: string[] }[];
  order: Map<string, number>;
  skipped: string[];
  /** Each `waiting` list written to the run record, as JSON. */
  updates: string[];
  endings: Map<string, Ending<{ issue: string }, string>>;
};

type FlowOptions = {
  /** Tickets that end without landing. */
  leave?: string[];
  /** Milliseconds a pipeline works, for all tickets or by id. */
  delay?: number | Record<string, number>;
  /** Tickets held for a blocker in the run: id -> the ticket they wait for, released when it lands. */
  after?: Record<string, string>;
  /** Runs inside a ticket's pipeline, as the branch gains its commits (`attempt` is 2 for a requeue). */
  work?: (t: Ticket, attempt: number) => void | Promise<void>;
  /** Tickets whose first landing conflicts: the scheduler requeues them once. */
  requeue?: string[];
  /** Tickets whose attempt finds a usage limit: it does not begin, and the run starts nothing more. */
  usageLimit?: string[];
  /** A ticket's label refusal. */
  badLabels?: Record<string, string>;
  /** A dry run: no files, so nothing is held. */
  dryRun?: boolean;
};

/**
 * Drives the scheduler as burndown.ts does: `createSchedule` with the real files (`ticketFiles`,
 * `refreshFiles`) and a fake blockers port, and the burndown's record of
 * the hold (`createHoldRecord`) given what `start` decided and what `tell` says. A fake attempt
 * works `delay` ms, then is green (or, for a ticket in `leave`, ends in its pipeline); a fake
 * landing merges it, or conflicts on a first landing in `requeue`.
 */
const runFlow = async (project: Project, tickets: Ticket[], opts: FlowOptions = {}): Promise<Flow> => {
  const after = opts.after ?? {};
  const out: Flow = { events: [], said: [], notes: {}, noted: [], peak: 0, started: [], waiting: [], order: new Map(), skipped: [], updates: [], endings: new Map() };
  const record = {
    ticket: (id: string, fields: { state?: string; note?: string | null }) => {
      if ("note" in fields) {
        out.notes[id] = fields.note;
        if (fields.note) out.noted.push(`${ref(id)} ${fields.note}`);
      }
      if (fields.state) out.events.push(`${fields.state} ${id}`);
      if (fields.state === "skipped") out.skipped.push(id);
    },
    update: (fields: Record<string, unknown>) => {
      if (fields.waiting) out.updates.push(JSON.stringify(fields.waiting));
    },
  };
  const say = (line: string) => void out.said.push(line.trim());
  const waiting = Object.entries(after).map(([issue, on]) => ({ issue, on: [ref(on)] }));
  // A ticket is released when the one it waits for lands: its one blocker reads as closed then.
  const held = tickets.filter((t) => after[t.id]);
  const schedule = createSchedule<Ticket, { issue: string }, string, string>({
    tickets: tickets.filter((t) => !after[t.id]),
    files: opts.dryRun ? undefined : { of: (t) => ticketFiles(project, t), refresh: (t, files) => refreshFiles(project, t, files) },
    blockers: { held: held.map((t) => ({ ticket: t, on: [after[t.id]] })), ticketOf: (b) => b, open: async (ts) => ts.map(() => []) },
    checkLabel: (t) => opts.badLabels?.[t.id],
  });
  const holds = createHoldRecord({ waiting, ref, say });
  holds.start(schedule.start);
  out.order = new Map(schedule.start.map((c, at) => [c.ticket.id, at] as const));
  for (const c of schedule.start) if (c.file) record.ticket(c.ticket.id, { state: "blocked", note: fileWaitNote(ref, c.file) });
  out.waiting = waiting;
  let running = 0;
  const landedOnce = new Set<string>();
  const { endings } = await schedule.run({
    workers: tickets.length,
    attempt: async (t, at) => {
      if (opts.usageLimit?.includes(t.id)) return { kind: "not begun", why: { kind: "usage limit", line: "usage 97% of the 5-hour window" } };
      running++;
      out.peak = Math.max(out.peak, running);
      out.events.push(`start ${t.id}`);
      out.started.push(t.id);
      await opts.work?.(t, at.n);
      const delay = typeof opts.delay === "number" ? opts.delay : (opts.delay?.[t.id] ?? 20);
      await new Promise((resolve) => setTimeout(resolve, delay));
      running--;
      if (opts.leave?.includes(t.id)) return { kind: "pipeline", outcome: "red" };
      return { kind: "green", green: { issue: t.id } };
    },
    land: async (g) => {
      if (opts.requeue?.includes(g.issue) && !landedOnce.has(g.issue)) {
        landedOnce.add(g.issue);
        return { kind: "conflict", files: [], with: [] };
      }
      out.events.push(`land ${g.issue}`);
      return { kind: "merged" };
    },
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      if (c.kind === "requeued") out.events.push(`requeue ${c.id}`);
      else if (c.kind === "started" || c.kind === "waits" || c.kind === "next run") holds.tell(record, c);
      // The burndown's wording of a refused label.
      else if (c.kind === "ended" && c.ending.kind === "not begun" && c.ending.why.kind === "refused label") {
        say(c.ending.why.reason);
        record.ticket(c.id, refusedRecord(c.ending.why.reason));
      }
    },
  });
  out.endings = endings;
  return out;
};

test("two tickets declaring one minified file never run at once, and the second starts after the first lands", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1", "dist/app.min.js"), ticket("2", "dist/app.min.js")]);
  assert.equal(out.peak, 1);
  assert.deepEqual(out.started, ["1", "2"]);
  assert.ok(out.events.indexOf("land 1") < out.events.indexOf("start 2"), out.events.join(" | "));
  assert.ok(out.said.includes("#2 waits for #1: both change dist/app.min.js (git cannot merge it)"), out.said.join(" | "));
  // Its note read that while it waited, and the release cleared it.
  assert.equal(out.notes["2"], null);
});

test("two tickets declaring one HTML page start together, and the start names the file", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1", "page.html"), ticket("2", "page.html")]);
  assert.equal(out.peak, 2);
  assert.deepEqual(out.events.slice(0, 2), ["start 1", "start 2"]);
  assert.deepEqual(out.said, ["#1 and #2 both change page.html - if they conflict at landing, the later one is sent back once and its merge resolved"]);
});

test("a lockfile from the branch diff alone, with no Touches line, still serialises", async () => {
  const r = repo();
  r.branch("1", ["pnpm-lock.yaml", "a.ts"]);
  r.branch("2", ["pnpm-lock.yaml", "b.ts"]);
  const out = await runFlow(r.project, [ticket("1"), ticket("2")]);
  assert.equal(out.peak, 1);
  assert.ok(out.events.indexOf("land 1") < out.events.indexOf("start 2"), out.events.join(" | "));
  assert.ok(out.said.includes("#2 waits for #1: both change pnpm-lock.yaml (git cannot merge it)"), out.said.join(" | "));
});

test("a branch's files and another ticket's declared file meet", async () => {
  const r = repo();
  r.branch("1", ["pnpm-lock.yaml"]);
  const out = await runFlow(r.project, [ticket("1"), ticket("2", "pnpm-lock.yaml")]);
  assert.equal(out.peak, 1);
});

test("a ticket without Touches and without a branch is never held", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1"), ticket("2"), ticket("3")]);
  assert.equal(out.peak, 3);
  assert.deepEqual(out.said, []);
});

test("a ticket that leaves the run without landing frees its file too", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1", "pnpm-lock.yaml"), ticket("2", "pnpm-lock.yaml")], { leave: ["1"] });
  assert.deepEqual(out.started, ["1", "2"]);
  assert.equal(out.peak, 1);
  assert.ok(!out.events.includes("land 1"));
});

test("tickets waiting for one file go in the order they waited, each behind the one before", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1", "pnpm-lock.yaml"), ticket("2", "pnpm-lock.yaml"), ticket("3", "pnpm-lock.yaml")]);
  assert.equal(out.peak, 1);
  assert.deepEqual(out.started, ["1", "2", "3"]);
  const at = (e: string) => out.events.indexOf(e);
  assert.ok(at("land 1") < at("start 2") && at("land 2") < at("start 3"), out.events.join(" | "));
  // Once 1 is done, 3 waits for 2, which has the file now.
  assert.ok(out.noted.includes("#3 waits for #2: both change pnpm-lock.yaml (git cannot merge it)"), out.noted.join(" | "));
});

test("a ticket waits only for the tickets that share its file", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1", "pnpm-lock.yaml"), ticket("2", "pnpm-lock.yaml"), ticket("3", "page.html")]);
  assert.deepEqual(out.events.filter((e) => e.startsWith("start")).slice(0, 2), ["start 1", "start 3"]);
});

test("mergeable files are named for each pair, three at most", () => {
  const { start } = createSchedule<Ticket, { issue: string }>({
    tickets: [ticket("1"), ticket("2")],
    files: { of: (t) => ({ all: t.id === "1" ? ["a", "b", "c", "d", "e"] : ["e", "d", "c", "b", "a", "z"], unmergeable: [] }) },
  });
  assert.deepEqual(start[1].shares?.map((s) => fileShareLine(ref, "2", s)), ["#1 and #2 both change a, b, c and 2 more - if they conflict at landing, the later one is sent back once and its merge resolved"]);
});

test("ticketFiles: the branch's files and the Touches line, and which of them git cannot merge", () => {
  const r = repo();
  r.branch("1", ["pnpm-lock.yaml", "src/x.ts"]);
  const f = ticketFiles(r.project, ticket("1", "dist/*.js, page.html"));
  assert.deepEqual([...f.all].sort(), ["dist/app.min.js", "page.html", "pnpm-lock.yaml", "src/x.ts"]);
  assert.deepEqual([...f.unmergeable].sort(), ["dist/app.min.js", "pnpm-lock.yaml"]);
  assert.deepEqual(ticketFiles(r.project, ticket("9")), { all: [], unmergeable: [] });
});

test("branchFiles: a branch already merged into main constrains nothing", () => {
  const r = repo();
  r.branch("1", ["a"]);
  r.git("merge", "-q", "--no-ff", "-m", "merge 1", "agent/issue-1");
  assert.deepEqual(branchFiles(r.root, "main", "1"), []);
});

test("branchFiles: three dots, not two - what main changed after a branch forked is not the branch's", () => {
  const r = repo();
  r.branch("1", ["x.txt"]);
  r.commit(["shared.txt"], "main changes shared.txt");
  assert.deepEqual(branchFiles(r.root, "main", "1"), ["x.txt"]);
});

test("branchFiles: no branch, no files", () => {
  const r = repo();
  assert.deepEqual(branchFiles(r.root, "main", "7"), []);
});

test("a ticket with no Touches line whose branch gains a lockfile while in flight holds a dependant that declares it", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1"), ticket("9"), ticket("3", "pnpm-lock.yaml")], {
    after: { "3": "9" },
    // 1 had no files when the run started; its pipeline commits the lockfile change afterwards.
    work: (t) => {
      if (t.id === "1") r.branch("1", ["pnpm-lock.yaml"]);
    },
    delay: { "1": 150, "9": 30, "3": 20 },
  });
  const at = (e: string) => out.events.indexOf(e);
  assert.ok(at("land 9") < at("start 3") && at("land 1") < at("start 3"), out.events.join(" | "));
  assert.ok(out.said.includes("#3 waits for #1: both change pnpm-lock.yaml (git cannot merge it)"), out.said.join(" | "));
  assert.equal(out.peak, 2);
});

test("a requeued holder keeps its file through the second attempt", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1", "pnpm-lock.yaml"), ticket("2", "pnpm-lock.yaml")], { requeue: ["1"] });
  assert.deepEqual(out.started, ["1", "1", "2"]);
  const at = (e: string) => out.events.indexOf(e);
  assert.ok(at("requeue 1") < at("land 1") && at("land 1") < at("start 2"), out.events.join(" | "));
  assert.equal(out.peak, 1);
});

test("the start puts a parked ticket on the candidates after the others, and a bad label skips it when its turn comes", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1", "pnpm-lock.yaml"), ticket("2", "pnpm-lock.yaml"), ticket("3", "pnpm-lock.yaml")], {
    badLabels: { "2": "NOT STARTED: label conflict" },
  });
  // The label is read at the start, the ticket skipped once its file is free, and the run still ends.
  assert.deepEqual([out.order.get("1"), out.order.get("2"), out.order.get("3")], [0, 1, 2]);
  assert.deepEqual(out.said.slice(0, 2), ["#2 waits for #1: both change pnpm-lock.yaml (git cannot merge it)", "#3 waits for #1: both change pnpm-lock.yaml (git cannot merge it)"]);
  assert.deepEqual(out.skipped, ["2"]);
  assert.deepEqual(out.started, ["1", "3"]);
  assert.ok(out.said.includes("NOT STARTED: label conflict"), out.said.join(" | "));
});

test("a ticket parked again behind another holder names the new one in waiting", async () => {
  const r = repo();
  const out = await runFlow(r.project, [ticket("1", "pnpm-lock.yaml"), ticket("4", "yarn.lock"), ticket("3", "pnpm-lock.yaml, yarn.lock")], { delay: { "1": 20, "4": 150, "3": 20 } });
  assert.ok(out.noted.includes("#3 waits for #4: both change yarn.lock (git cannot merge it)"), out.noted.join(" | "));
  assert.ok(out.updates.includes(JSON.stringify([{ issue: "3", on: ["#4"] }])), out.updates.join(" | "));
  assert.ok(out.events.indexOf("land 4") < out.events.indexOf("start 3"), out.events.join(" | "));
});

test("a stopped run leaves each parked ticket with the next-run note and a waiting entry for its holder now", async () => {
  const r = repo();
  // 5 finds a usage limit as it would begin: the run starts nothing more, and what is green still lands.
  const out = await runFlow(r.project, [ticket("1", "pnpm-lock.yaml"), ticket("4", "yarn.lock"), ticket("2", "pnpm-lock.yaml"), ticket("3", "pnpm-lock.yaml, yarn.lock"), ticket("5")], {
    usageLimit: ["5"],
    delay: { "1": 20, "4": 150 },
  });
  // Nothing parked starts. 1 landed, so 3 waits for 4 (which still has yarn.lock) and 2 for nobody.
  assert.deepEqual(out.started, ["1", "4"]);
  assert.ok(out.noted.includes("#3 waits for #4 (git cannot merge yarn.lock) - next run"), out.noted.join(" | "));
  assert.ok(out.noted.includes("#2 stopped before it could start - next run"), out.noted.join(" | "));
  assert.ok(out.updates.includes(JSON.stringify([{ issue: "3", on: ["#4"] }])), out.updates.join(" | "));
  // Once 4 has landed too, no ticket keeps naming a holder that is gone.
  assert.equal(out.notes["3"], "stopped before it could start - next run");
  assert.deepEqual(JSON.parse(out.updates.at(-1) ?? "[]"), []);
  assert.deepEqual(out.waiting, []);
  assert.deepEqual([out.endings.get("2"), out.endings.get("3")], [{ kind: "waiting", on: "file" }, { kind: "waiting", on: "file" }]);
});

test("refreshFiles adds the branch's files to what was read, and recomputes which git cannot merge", () => {
  const r = repo();
  const before = ticketFiles(r.project, ticket("1"));
  assert.deepEqual(before, { all: [], unmergeable: [] });
  r.branch("1", ["pnpm-lock.yaml", "a.ts"]);
  const now = refreshFiles(r.project, ticket("1"), { all: ["kept.ts"], unmergeable: [] });
  assert.deepEqual([...now.all].sort(), ["a.ts", "kept.ts", "pnpm-lock.yaml"]);
  assert.deepEqual(now.unmergeable, ["pnpm-lock.yaml"]);
});
