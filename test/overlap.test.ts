// Which tickets start together (createFileHold in src/schedule.ts, wired by createRelease in
// src/blockers.ts and burndown.ts as burndown.ts does). Tickets that share a file git cannot merge
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
const { branchFiles, ticketFiles } = await import("../src/burndown.ts");
const { createDependants, createRelease } = await import("../src/blockers.ts");
const { createFlow } = await import("../src/landing.ts");
const { createFileHold, createQueue, fileShareLine, fileWaitNote } = await import("../src/schedule.ts");
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

type Flow = { events: string[]; said: string[]; notes: Record<string, string | null | undefined>; noted: string[]; peak: number; started: string[] };

/**
 * Wires what burndown.ts wires: the file hold at the start, `createFlow` over the pipeline queue,
 * `createRelease` with the hold after each ticket's last word. A fake pipeline works `delay` ms,
 * then "lands" (or, for a ticket in `leave`, ends without landing).
 */
const runFlow = async (project: Project, tickets: Ticket[], opts: { leave?: string[]; delay?: number } = {}): Promise<Flow> => {
  const out: Flow = { events: [], said: [], notes: {}, noted: [], peak: 0, started: [] };
  const record = {
    ticket: (id: string, fields: { state?: string; note?: string | null }) => {
      if ("note" in fields) {
        out.notes[id] = fields.note;
        if (fields.note) out.noted.push(`${ref(id)} ${fields.note}`);
      }
      if (fields.state) out.events.push(`${fields.state} ${id}`);
    },
    update: () => {},
  };
  const hold = createFileHold<Ticket>((t) => ticketFiles(project, t));
  const starting: Ticket[] = [];
  for (const t of tickets) {
    const at = hold.admit(t);
    if ("wait" in at) {
      record.ticket(t.id, { state: "blocked", note: fileWaitNote(ref, at.wait) });
      out.said.push(`${ref(t.id)} ${fileWaitNote(ref, at.wait)}`);
    } else {
      starting.push(t);
      for (const s of at.shares) out.said.push(fileShareLine(ref, t.id, s));
    }
  }
  const queue = createQueue<Ticket>();
  const flow = createFlow(starting.length, queue, { close() {} });
  const dependants = createDependants(project, {} as never, tickets, new Map());
  const { afterLanding } = createRelease({
    dependants,
    hold,
    start: (t) => flow.start(t),
    finish: () => flow.finish(),
    stopped: () => false,
    dryRun: false,
    badLabel: () => undefined,
    record,
    waiting: [],
    ref,
    say: (line) => out.said.push(line.trim()),
  });
  let running = 0;
  const pipelines = queue.run(
    tickets.length,
    flow.work(
      async (t) => {
        running++;
        out.peak = Math.max(out.peak, running);
        out.events.push(`start ${t.id}`);
        out.started.push(t.id);
        await new Promise((resolve) => setTimeout(resolve, opts.delay ?? 20));
        running--;
        if (opts.leave?.includes(t.id)) return false;
        out.events.push(`land ${t.id}`);
        await afterLanding(t.id, true);
        return true;
      },
      (t) => afterLanding(t.id, false),
    ),
  );
  for (const t of starting) queue.push(t);
  await pipelines;
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
  assert.deepEqual(out.said, ["#1 and #2 both change page.html - landing resolves it"]);
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
  const hold = createFileHold<Ticket>((t) => ({ all: t.id === "1" ? ["a", "b", "c", "d", "e"] : ["e", "d", "c", "b", "a", "z"], unmergeable: [] }));
  hold.admit(ticket("1"));
  const at = hold.admit(ticket("2"));
  assert.ok("shares" in at);
  assert.deepEqual(at.shares.map((s) => fileShareLine(ref, "2", s)), ["#1 and #2 both change a, b, c and 2 more - landing resolves it"]);
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
