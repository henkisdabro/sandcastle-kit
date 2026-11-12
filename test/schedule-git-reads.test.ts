// How many git commands making the schedule costs. `createSchedule` admits every ticket at once
// through the file hold, with the real `ticketFiles` and `refreshFiles` (as burndown.ts wires them)
// over a temp repo, and a `git` shim on PATH counts every spawn. The cost must be linear in the
// tickets: a start used to re-read the files of every ticket already admitted at each admit, so 39
// tickets made about 1,600 git commands. Also: an in-flight ticket whose branch did not move is
// still read again when the base gained a file git cannot merge. No Docker, model calls or network.
//
//   pnpm test:file test/schedule-git-reads.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

// Importing burndown.ts must not touch the real config or cache.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { refreshFiles, ticketFiles } = await import("../src/burndown.ts");
const { createSchedule } = await import("../src/schedule.ts");
type Project = import("../src/config.ts").Project;
type Ticket = import("../src/tracker.ts").Ticket;

const MINIFIED = `${"var a=function(b){return b+1};".repeat(100)}\n`;

// A `git` that appends one line to a log, then runs the real one. spawnSync and execFileSync look
// `git` up on PATH, so putting the shim first counts every spawn of this process.
const shim = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-git-shim-"));
  const log = join(dir, "spawns");
  writeFileSync(log, "");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const script = join(dir, "git");
  writeFileSync(script, `#!/bin/sh\necho "$1" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(script, 0o755);
  process.env.PATH = [dir, process.env.PATH ?? ""].join(delimiter);
  return {
    reset: () => writeFileSync(log, ""),
    spawns: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
};
const counter = shim();

// A repo on `main` with 50 files, and a committer for the plumbing around it.
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-reads-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  for (let i = 0; i < 50; i++) write(`src/mod${i % 10}/file${i}.ts`, `export const n${i} = ${i};\n`);
  write("pnpm-lock.yaml", "lock\n");
  write("dist/bundle.js", "small\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const project = { root, name: "fixture", baseBranch: "main", generated: [], gates: [], setup: [] } as unknown as Project;
  return { root, git, write, project };
};

const ticket = (id: string, touches: string): Ticket => ({ id, title: `ticket ${id}`, body: `Do it.\n\nTouches: ${touches}\n`, comments: [] });
const queue = (n: number) => Array.from({ length: n }, (_, i) => ticket(String(i + 1), `src/mod${i % 10}/**, src/mod${i % 10}/file${i}.ts, docs/new-${i}.md`));

/** The git commands `createSchedule` spawns while it makes the schedule for `tickets`. */
const scheduleSpawns = (project: Project, tickets: Ticket[]) => {
  counter.reset();
  const { start } = createSchedule<Ticket, { issue: string }, string, string>({
    tickets,
    files: { of: (t) => ticketFiles(project, t), refresh: (t, files) => refreshFiles(project, t, files) },
  });
  assert.equal(start.length, tickets.length, "every ticket is a candidate");
  return counter.spawns();
};

test("making the schedule for 39 tickets spawns at most 4 git commands per ticket plus a constant", () => {
  const r = repo();
  const spawns = scheduleSpawns(r.project, queue(39));
  assert.ok(spawns.length <= 4 * 39 + 10, `${spawns.length} git spawns: ${[...new Set(spawns)].join(", ")}`);
});

test("with an agent branch for each of the 39 tickets, the spawn count is still linear (at most 8 per ticket plus a constant)", () => {
  const r = repo();
  const tickets = queue(39);
  tickets.forEach((t, i) => {
    r.git("branch", `agent/issue-${t.id}`, "main");
    r.git("checkout", "-q", `agent/issue-${t.id}`);
    r.write(`src/mod${i % 10}/file${i}.ts`, `export const changed${i} = 1;\n`);
    r.git("add", "-A");
    r.git("commit", "-q", "-m", `issue ${t.id}`);
    r.git("checkout", "-q", "main");
  });
  const spawns = scheduleSpawns(r.project, tickets);
  assert.ok(spawns.length <= 8 * 39 + 10, `${spawns.length} git spawns: ${[...new Set(spawns)].join(", ")}`);
});

test("a ticket in flight whose branch and base did not move is not read again", () => {
  const r = repo();
  r.git("branch", "agent/issue-1", "main");
  const t = ticket("1", "src/mod1/**");
  const first = ticketFiles(r.project, t);
  counter.reset();
  assert.equal(refreshFiles(r.project, t, first), first);
  assert.ok(counter.spawns().every((s) => s === "rev-parse"), `only the tip and the base are resolved: ${counter.spawns().join(", ")}`);
});

test("after the base gains a minified file, an in-flight ticket with an unchanged tip is read again and the file is unmergeable", () => {
  const r = repo();
  r.git("branch", "agent/issue-1", "main");
  const t = ticket("1", "dist/bundle.js");
  const before = ticketFiles(r.project, t);
  assert.deepEqual(before.unmergeable, []);
  r.write("dist/bundle.js", MINIFIED);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "the bundle is minified now");
  const after = refreshFiles(r.project, t, before);
  assert.deepEqual(after.all, ["dist/bundle.js"]);
  assert.deepEqual(after.unmergeable, ["dist/bundle.js"]);
});

test("in the scheduler, a ticket released after the base gained a minified file waits for the in-flight ticket that touches it", async () => {
  const r = repo();
  r.git("branch", "agent/issue-1", "main");
  r.git("branch", "agent/issue-2", "main");
  const tickets = [ticket("1", "dist/bundle.js"), ticket("2", "dist/bundle.js")];
  const three = ticket("3", "dist/bundle.js");
  const schedule = createSchedule<Ticket, { issue: string }, string, string>({
    tickets,
    files: { of: (t) => ticketFiles(r.project, t), refresh: (t, files) => refreshFiles(r.project, t, files) },
    // 3 waits for 1; it is released when 1 lands, after the base gained the minified bundle.
    blockers: { held: [{ ticket: three, on: ["1"] }], ticketOf: (b) => b, open: async (ts) => ts.map(() => []) },
  });
  assert.deepEqual(schedule.start.map((c) => c.ticket.id), ["1", "2", "3"]);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const told: { kind: string; id?: string; wait?: { with: string; file: string } }[] = [];
  const done = schedule.run({
    workers: 4,
    attempt: async (t) => {
      if (t.id === "1") {
        r.write("dist/bundle.js", MINIFIED);
        r.git("add", "-A");
        r.git("commit", "-q", "-m", "the bundle is minified now");
      }
      if (t.id === "2") await held;
      return { kind: "green", green: { issue: t.id } };
    },
    land: async () => ({ kind: "merged" }),
    host: { check: async () => {}, failed: undefined },
    tell: (c) => {
      const change = c as { kind: string; id?: string; wait?: { with: string; file: string } };
      told.push(change);
      if (change.kind === "waits" && change.id === "3") release();
    },
  });
  await done;
  const waits = told.find((c) => c.kind === "waits" && c.id === "3");
  assert.deepEqual(waits?.wait, { with: "2", file: "dist/bundle.js" });
});
