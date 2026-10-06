// `sandcastle pause` and `sandcastle resume`: a soft pause of a live run. No new ticket and no new agent
// pass starts, the passes in flight finish, and at that juncture the ticket's sandbox closes (its branch
// stays); green branches still land; the run's demand for sandbox slots drops to 0 and keep-awake is
// released; the resume continues each paused ticket from its next phase, in the same run.
//
// The scheduler is driven through its ports (`createSchedule` with fake attempt and land ports and a pause
// source), the pipeline over a temp repo with a worktree for the sandbox and scripted agents, the commands
// through the real CLI in a throwaway repo with a stand-in for the live run. No Docker, no model, no network.
//
//   pnpm exec tsx --test test/pause-resume.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { isTicketState, GROUPS, TICKET_STATES } from "../mod/hooks/run-record.ts";
import { liveness } from "../mod/hooks/run-live.ts";
import { runKit } from "./cli-spawn.ts";
import { everyPidIsTheKit, kitLikeProcess } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { createSchedule } = await import("../src/schedule.ts");
const { PAUSE_FILE, readPause, waitForRun } = await import("../src/detach.ts");
const { holdAwake, keepAwake, releaseAwake } = await import("../src/run.ts");
const { lineText, runCounts, spaceText } = await import("../src/herdr.ts");
const { render } = await import("../src/report.ts");
type Change = import("../src/schedule.ts").Change<G, string, string>;
type Facts = import("../src/report.ts").Facts;
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

type T = { id: string };
type G = { issue: string };

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-pause-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const green = (id: string) => ({ kind: "green", green: { issue: id } }) as const;
const merged = async () => ({ kind: "merged" }) as const;
const host = { check: async () => {}, failed: undefined };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), `timed out waiting for ${what}`);
};
/** The condition holds for `ms`: something that must not happen while paused did not. */
const steady = async (ok: () => boolean, what: string, ms = 60) => {
  for (let t = 0; t < ms; t += 5) {
    assert.ok(ok(), what);
    await sleep(5);
  }
};
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

/** The pause a person has asked for, as the run reads it: asked and lifted by the test, polled every few milliseconds. */
const control = () => {
  let since: number | undefined;
  return {
    source: { read: () => (since === undefined ? undefined : { since }), pollMs: 5 },
    pause: () => void (since = 1_790_000_000),
    resume: () => void (since = undefined),
  };
};
const demands = (told: Change[]) => told.flatMap((c) => (c.kind === "demand" ? [c.n] : []));
const finishings = (told: Change[]) => told.flatMap((c) => (c.kind === "paused" ? [[...c.finishing].sort()] : []));

test("a pause parks the ticket that finished its pass before its review, starts no waiting ticket, still lands a green branch, and the resume goes on", async () => {
  const pause = control();
  const implementing = gate();
  const finished = gate();
  const log: string[] = [];
  const told: Change[] = [];
  // The branch commit ticket 1's implement pass made: its review must see the same one after the resume.
  let branchCommit = "";
  let over = false;
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "3" }, { id: "1" }, { id: "2" }] }).run({
    workers: 2,
    concurrency: 2,
    pause: pause.source,
    attempt: async (t, at) => {
      log.push(`start ${t.id}`);
      if (t.id === "3") {
        await finished.opened;
        return green("3");
      }
      if (t.id === "1") {
        await implementing.opened;
        branchCommit = "a1b2c3d";
        log.push("implemented 1");
        await at.juncture("review", {
          suspend: async () => void log.push("sandbox 1 closed"),
          resume: async () => void log.push("sandbox 1 opened"),
        });
        log.push(`review 1 at ${branchCommit}`);
      }
      return green(t.id);
    },
    land: async (g) => {
      log.push(`land ${g.issue}`);
      return merged();
    },
    host,
    tell: (c) => void told.push(c),
  });
  void done.then(() => (over = true));
  await until(() => log.includes("start 3") && log.includes("start 1"), "tickets 3 and 1 to start");
  assert.deepEqual(demands(told), [2]);

  // Paused while 1 implements and 2 waits for a worker.
  pause.pause();
  await until(() => told.some((c) => c.kind === "paused"), "the pause to be told");
  assert.deepEqual(finishings(told)[0], ["1", "3"], "both tickets in a pass are still finishing");

  // 3's pass ends green: it is queued for landing, and lands while the run is paused. The worker it
  // frees does not start ticket 2.
  finished.open();
  await until(() => log.includes("land 3"), "the green branch to land");
  await steady(() => !log.includes("start 2"), "a waiting ticket started while the run was paused");

  // 1's pass ends: it stops before its review, with its sandbox closed, and nothing is left in flight.
  implementing.open();
  await until(() => log.includes("sandbox 1 closed"), "ticket 1 to close its sandbox");
  await until(() => finishings(told).at(-1)?.length === 0, "nothing to be in flight");
  await steady(() => !log.some((l) => l.startsWith("review 1") || l === "start 2" || l === "sandbox 1 opened") && !over, "work went on, or the run ended, while it was paused");
  assert.equal(demands(told).at(-1), 0, "a paused run with nothing in flight asks for no sandbox slot");
  assert.ok(!told.some((c) => c.kind === "resumed"));
  const whilePaused = demands(told).length;

  pause.resume();
  const { endings } = await done;
  // The first ticket's review ran on the sandbox opened after the resume, on the commit its implement pass left.
  assert.ok(log.indexOf("sandbox 1 opened") > log.indexOf("sandbox 1 closed"));
  assert.ok(log.indexOf("review 1 at a1b2c3d") > log.indexOf("sandbox 1 opened"));
  assert.ok(log.indexOf("start 2") > log.indexOf("sandbox 1 closed"), "the second ticket starts after the resume");
  assert.equal(told.filter((c) => c.kind === "resumed").length, 1);
  assert.ok(demands(told).slice(whilePaused).some((d) => d >= 1), "the demand comes back with the resume");
  assert.equal(demands(told).at(-1), 0, "and is 0 again once the run is drained");
  assert.deepEqual([...endings].map(([id, e]) => `${id} ${e.kind}`).sort(), ["1 landing", "2 landing", "3 landing"]);
});

test("a run paused before its first ticket begins starts nothing until the resume", async () => {
  const pause = control();
  pause.pause();
  const log: string[] = [];
  const told: Change[] = [];
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }, { id: "2" }] }).run({
    workers: 2,
    pause: pause.source,
    attempt: async (t) => (log.push(`start ${t.id}`), green(t.id)),
    land: merged,
    host,
    tell: (c) => void told.push(c),
  });
  await until(() => told.some((c) => c.kind === "paused"), "the pause to be told");
  await steady(() => log.length === 0, "a ticket started while the run was paused");
  assert.deepEqual(finishings(told), [[]]);
  assert.deepEqual(demands(told), [0], "it asked for no slot at all: the pause was in force before the first demand was told");
  pause.resume();
  await done;
  assert.ok(demands(told).slice(1).some((d) => d === 2), "and asked for both on the resume");
  assert.deepEqual([...log].sort(), ["start 1", "start 2"]);
});

test("a pause lifted before a ticket reaches a juncture costs nothing: it goes straight on", async () => {
  const pause = control();
  const log: string[] = [];
  const hold = gate();
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    pause: pause.source,
    attempt: async (t, at) => {
      await hold.opened;
      await at.juncture("review", { suspend: async () => void log.push("closed"), resume: async () => void log.push("opened") });
      log.push("review");
      return green(t.id);
    },
    land: merged,
    host,
    tell: () => {},
  });
  pause.pause();
  await sleep(20);
  pause.resume();
  await sleep(20);
  hold.open();
  await done;
  assert.deepEqual(log, ["review"], "the sandbox never closed");
});

test("an attempt can ask whether the run is paused now, before any juncture or poll has noticed", async () => {
  const pause = control();
  const asked: boolean[] = [];
  const hold = gate();
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    // A slow poll: only the question itself reads the pause.
    pause: { read: pause.source.read, pollMs: 100_000 },
    attempt: async (t, at) => {
      asked.push(at.paused());
      await hold.opened;
      asked.push(at.paused());
      return green(t.id);
    },
    land: merged,
    host,
    tell: () => {},
  });
  await sleep(10);
  pause.pause();
  hold.open();
  await done;
  assert.deepEqual(asked, [false, true]);
});

test("a run with no pause source holds nothing, and a juncture returns at once", async () => {
  const log: string[] = [];
  const { endings } = await createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    attempt: async (t, at) => {
      await at.juncture("review", { suspend: async () => void log.push("closed"), resume: async () => void log.push("opened") });
      return green(t.id);
    },
    land: merged,
    host,
    tell: () => {},
  });
  assert.deepEqual(log, []);
  assert.equal(endings.get("1")?.kind, "landing");
});

// ---------------------------------------------------------------------------
// The pipeline under the scheduler: a temp repo, a worktree for each sandbox, scripted agents.
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

test("a ticket paused after its implement pass closes its sandbox, and its review runs on a fresh one on the same branch commit", async () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n");
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];

  const pause = control();
  const events: string[] = [];
  const phases: string[] = [];
  const writes: { state?: string; note?: string | null }[] = [];
  const waited = new Map<string, number>();
  const sandboxes: { path: string; closed: boolean }[] = [];
  let reviewedAt = "";
  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const record = { path, closed: false };
    sandboxes.push(record);
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const kind = (opts.name ?? "").split("-")[0];
        events.push(`${kind} in sandbox ${sandboxes.indexOf(record)}`);
        const before = git(path, "rev-parse", "HEAD");
        if (kind === "impl") {
          // The person pauses the run while this pass is running: it finishes, and the next pass does not begin.
          pause.pause();
          commit(path, "a.txt", "a\n");
        }
        if (kind === "review") reviewedAt = git(path, "rev-parse", "HEAD");
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        record.closed = true;
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };
  const pipeline = createPipeline({
    project: { root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }], generated: [], setup: [], implement: {}, review: {}, repair: {}, changelog: true } as unknown as Ctx["project"],
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-05T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async (box) => (events.push(`gate in sandbox ${sandboxes.findIndex((s) => s.path === box.worktreePath)}`), GREEN),
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, phase, fn) => (phases.push(phase), fn()),
    run: { ticket: (_id, fields) => void writes.push({ state: fields.state, note: fields.note }) },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    waited,
    keptWorktrees: [],
    tampered: new Map(),
  });

  const issue = { id: "7", title: "seven", body: "" } as Parameters<typeof pipeline>[0];
  const told: Change[] = [];
  let outcome: Awaited<ReturnType<typeof pipeline>> | undefined;
  const done = quietly(() =>
    createSchedule<T, G, string, string>({ tickets: [issue] }).run({
      workers: 1,
      pause: pause.source,
      attempt: async (_t, at) => {
        outcome = await pipeline(issue, at);
        return { kind: "pipeline", outcome: outcome.status };
      },
      land: merged,
      host,
      tell: (c) => void told.push(c),
    }),
  );
  await until(() => writes.some((w) => w.state === "paused"), "the ticket to park");
  const head = git(root, "rev-parse", "--short", "agent/issue-7");
  assert.deepEqual(events, ["impl in sandbox 0"], "the implement pass finished; no review began");
  assert.equal(sandboxes[0]?.closed, true, "the sandbox closed at the juncture");
  assert.equal(existsSync(sandboxes[0]!.path), false);
  assert.deepEqual(writes.find((w) => w.state === "paused"), { state: "paused", note: `before review at ${head}` }, "the ticket records where it stands");
  assert.equal(git(root, "rev-list", "--count", "main..agent/issue-7"), "1", "the branch keeps the pass's commit");
  assert.equal(demands(told).at(-1), 0);
  await steady(() => sandboxes.length === 1 && events.length === 1, "a pass began or a sandbox opened while the run was paused");

  pause.resume();
  await done;
  assert.equal(outcome?.status, "green");
  assert.deepEqual(events, ["impl in sandbox 0", "review in sandbox 1", "gate in sandbox 1"], "the review runs in a fresh sandbox, and implement is not run again");
  assert.equal(reviewedAt, git(root, "rev-parse", "agent/issue-7"), "on the commit the implement pass left");
  assert.equal(git(root, "rev-parse", "agent/issue-7"), git(root, "rev-parse", head));
  assert.deepEqual(phases, ["setup", "implement", "setup", "review", "gates"]);
  assert.ok((waited.get("7") ?? 0) >= 50, "the time parked is a wait, not the ticket's usual time");
});

// ---------------------------------------------------------------------------
// The closing summary of a run that ends while paused.
// ---------------------------------------------------------------------------

const facts = (over: Partial<Facts>): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-05T06:41:00.000Z",
  finished: "2026-10-05T07:10:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 2,
  tickets: {
    "57": { state: "paused", title: "wordWrap", started: 1, note: "before review at a1b2c3d" },
    "58": { state: "paused", title: "median", started: 1, note: "before repair at 9f8e7d6" },
    "59": { state: "merged", title: "mean", started: 1 },
    "60": { state: "queued", title: "mode" },
  },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "running",
  exitCode: 130,
  stoppedBy: "sandcastle stop",
  ...over,
});
const section = (text: string, heading: string) => text.split(heading)[1]?.split("\n## ")[0] ?? "";

test("a run stopped while paused lists the paused tickets under Runnable now, and says where each stood", () => {
  const out = render(facts({}), true);
  assert.match(out, /^## Run stopped by `sandcastle stop` - partial summary/);
  const left = section(out, "## Runnable now / Still blocked");
  assert.match(left, /Runnable now: #57 \(paused before review at a1b2c3d - its branch resumes\), #58 \(paused before repair at 9f8e7d6 - its branch resumes\)/);
  assert.doesNotMatch(left, /Cut short/, "a parked ticket was not cut short: its branch holds every commit");
  assert.match(left, /Not started \(the run ended early\): #60/);
  assert.match(section(out, "## Next step"), /`sandcastle run` again: it picks up #57 #58 #60 where this run ended/);
  assert.match(out, / - 3 attempted - 1 merged - /, "the paused tickets did work, so they are attempted");
});

test("a killed run lists them the same way, next to a ticket cut short mid-pass", () => {
  const out = render(
    facts({ finished: undefined, killed: true, exitCode: undefined, stoppedBy: undefined, tickets: { "57": { state: "paused", title: "wordWrap", started: 1, note: "before review at a1b2c3d" }, "61": { state: "review", title: "range", started: 1 } } }),
    true,
  );
  const left = section(out, "## Runnable now / Still blocked");
  assert.match(left, /Runnable now: #57 \(paused before review at a1b2c3d - its branch resumes\)/);
  assert.match(left, /Cut short when the run ended: #61 \(review\) - still queued/);
});

test("a summary asked for while the run is paused says so, and lists no ticket as left", () => {
  const out = render(facts({ finished: undefined, live: true, paused: { since: 1_790_000_000 }, exitCode: undefined, stoppedBy: undefined }), true);
  assert.match(out, /^## Run still running, paused since \d\d:\d\d - partial summary/);
  assert.doesNotMatch(section(out, "## Runnable now / Still blocked"), /#57/);
});

// ---------------------------------------------------------------------------
// The record, the views and the machine.
// ---------------------------------------------------------------------------

test("`paused` is a ticket state of the queued group, and a paused run's process is live", () => {
  assert.ok(TICKET_STATES.includes("paused"));
  assert.ok(isTicketState("paused"));
  assert.equal(GROUPS.paused, "queued");
  // The mod's end prompt and every view read this rule: the paused run's process runs and its record has not finished.
  const record = { pid: 4242, paused: { since: 1_790_000_000, finishing: [] } };
  assert.deepEqual(liveness({ record }, () => everyPidIsTheKit()), { state: "live", pid: 4242 });
});

test("the sidebar and the tab bar say paused in place of the working count", () => {
  const tickets = { a: { state: "merged" as const }, b: { state: "review" as const }, c: { state: "paused" as const }, d: { state: "queued" as const } };
  assert.equal(spaceText(runCounts(tickets)), "♜ 1/4 · 1 working");
  assert.equal(spaceText(runCounts(tickets, true)), "♜ 1/4 · paused");
  assert.equal(lineText("shop", runCounts(tickets)), "shop 1/4 · 1 working");
  assert.equal(lineText("shop", runCounts(tickets, true), 0), "shop 1/4 · paused · share 0");
  // What needs a person still comes first in the sidebar, and the tab bar has room for both.
  const hot = { ...tickets, e: { state: "red" as const } };
  assert.equal(spaceText(runCounts(hot, true)), "♜ 1/5 · 1 needs you");
  assert.equal(lineText("shop", runCounts(hot, true)), "shop 1/5 · paused · 1 needs you");
  assert.deepEqual(runCounts({ a: { state: "merged" } }), { working: 0, needsYou: 0, merged: 1, total: 1 }, "a run that is not paused has no paused field");
});

test("a paused run with nothing in flight lets the machine sleep, and the resume holds it awake again", async () => {
  const bin = join(mkdtempSync(join(TMP, "bin")), "bin");
  mkdirSync(bin);
  const pidFile = join(TMP, `inhibitor${n++}`);
  // The inhibitor stands in for caffeinate / systemd-inhibit: it records its pid and ends with the test process, as the real one ends with the run's.
  for (const name of ["caffeinate", "systemd-inhibit"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n[ "$1" = "-h" ] && exit 0\necho $$ >>${JSON.stringify(pidFile)}\nwhile kill -0 "$PPID" 2>/dev/null; do sleep 1; done\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const saved = { PATH: process.env.PATH, KEEP_AWAKE: process.env.KEEP_AWAKE };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.KEEP_AWAKE = "1";
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pids = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
  try {
    assert.match(await keepAwake(), /^on \(/);
    await until(() => pids().length === 1, "the inhibitor to start");
    const first = pids()[0]!;
    assert.ok(alive(first));
    releaseAwake();
    await until(() => !alive(first), "the inhibitor to end on the pause");
    // Released once: a second call, or a resume that finds nothing released, starts nothing.
    releaseAwake();
    await holdAwake();
    await until(() => pids().length === 2, "the inhibitor to start again on the resume");
    assert.ok(alive(pids()[1]!));
    await holdAwake();
    await sleep(50);
    assert.equal(pids().length, 2, "a resume that finds the machine already held starts no second inhibitor");
    // Nothing was released, so nothing is held again by a later resume.
    process.kill(pids()[1]!, "SIGTERM");
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.KEEP_AWAKE === undefined) delete process.env.KEEP_AWAKE;
    else process.env.KEEP_AWAKE = saved.KEEP_AWAKE;
  }
});

// ---------------------------------------------------------------------------
// The commands.
// ---------------------------------------------------------------------------

const project = () => {
  const root = mkdtempSync(join(TMP, "project"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  return root;
};
const kit = (root: string, command: string) => {
  const r = runKit([command], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test("pause and resume with no live run say so and exit 0", () => {
  const root = project();
  for (const command of ["pause", "resume"]) {
    assert.deepEqual(kit(root, command), { status: 0, out: "No run is live.", err: "" }, command);
  }
  assert.equal(existsSync(join(root, PAUSE_FILE)), false, "nothing was written for a run that is not there");
  // A run lock left by a process that is gone is no live run.
  writeFileSync(join(root, ".sandcastle/logs/run.lock"), "99999999 token project\n");
  assert.equal(kit(root, "pause").out, "No run is live.");
});

test("pause writes the control file the run reads; pausing again, or resuming a run that is not paused, says so and changes nothing", () => {
  const root = project();
  const run = kitLikeProcess();
  try {
    writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${run.pid} token project\n`);
    assert.equal(readPause(root, run.pid), undefined);
    assert.match(kit(root, "resume").out, new RegExp(`^The run \\(pid ${run.pid}\\) is not paused\\.$`));

    const first = kit(root, "pause");
    assert.equal(first.status, 0, first.err);
    assert.match(first.out, new RegExp(`^Pausing the run \\(pid ${run.pid}\\): no new ticket or agent pass starts`));
    const since = readPause(root, run.pid)?.since;
    assert.ok(since && Math.abs(since - Date.now() / 1000) < 60, "the file holds when it was paused");

    const again = kit(root, "pause");
    assert.equal(again.status, 0);
    assert.match(again.out, new RegExp(`^The run \\(pid ${run.pid}\\) is already paused, since \\d\\d:\\d\\d\\. \`sandcastle resume\` continues it\\.$`));
    assert.equal(readPause(root, run.pid)?.since, since, "pausing a paused run changes nothing");

    const resumed = kit(root, "resume");
    assert.equal(resumed.status, 0, resumed.err);
    assert.match(resumed.out, new RegExp(`^Resuming the run \\(pid ${run.pid}, paused since \\d\\d:\\d\\d\\)`));
    assert.equal(existsSync(join(root, PAUSE_FILE)), false);
    assert.match(kit(root, "resume").out, /is not paused\.$/);
  } finally {
    run.kill();
  }
});

test("a pause belongs to the run it was asked of: a file left by a run that died pauses the next one no more", () => {
  const root = project();
  const run = kitLikeProcess();
  try {
    writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${run.pid} token project\n`);
    mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
    writeFileSync(join(root, PAUSE_FILE), JSON.stringify({ pid: run.pid + 1, since: 1_790_000_000 }));
    assert.equal(readPause(root, run.pid), undefined, "another run's pause");
    writeFileSync(join(root, PAUSE_FILE), "not json");
    assert.equal(readPause(root, run.pid), undefined, "an unreadable file pauses nothing and does not throw");
    // The stale file is replaced by a pause of the live run, not mistaken for one.
    assert.match(kit(root, "pause").out, /^Pausing the run/);
    assert.ok(readPause(root, run.pid));
    writeFileSync(join(root, PAUSE_FILE), JSON.stringify({ pid: run.pid + 1, since: 1_790_000_000 }));
    assert.match(kit(root, "resume").out, /is not paused\.$/);
    assert.equal(existsSync(join(root, PAUSE_FILE)), false, "a resume removes the stale file too");
  } finally {
    run.kill();
  }
});

test("`wait` keeps waiting through a pause, and `stop` still stops a paused run", async () => {
  const root = project();
  const run = kitLikeProcess();
  try {
    writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${run.pid} token project\n`);
    assert.match(kit(root, "pause").out, /^Pausing the run/);
    // A paused run is a live one: its lock is held and its record has not finished.
    const waited = await waitForRun(root, 0.3, 50);
    assert.deepEqual(waited, { ended: false, pid: run.pid });
    const stopped = kit(root, "stop");
    assert.equal(stopped.status, 0, stopped.err);
    assert.match(stopped.out, new RegExp(`^Stopping the run \\(pid ${run.pid}\\)`));
  } finally {
    run.kill();
  }
});

test("pause and resume take no argument, and the help names them", () => {
  const root = project();
  for (const command of ["pause", "resume"]) {
    const r = kit(root, command);
    assert.equal(r.status, 0);
    const bad = runKit([command, "now"], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, new RegExp(`Unknown argument "now" for sandcastle ${command}`));
    const help = runKit([command, "--help"], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
    assert.equal(help.status, 0);
    assert.match(help.stdout, new RegExp(`^ {2}${command} `, "m"));
  }
});
