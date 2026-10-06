// USAGE_PAUSE: a run that waits out a plan window instead of running into it. With the setting on, the run
// takes the soft pause of `sandcastle pause` itself when a window of a provider it uses reaches the threshold
// (from the agents' own readings), or when an agent hits the limit anyway, and resumes by itself a minute
// after that window's reset. A person's `sandcastle resume` resumes earlier; a person's `sandcastle pause` is
// never undone by the timer. The guard (`USAGE_CHECK`) prefers the same readings to the endpoint.
//
// The scheduler is driven through its ports with a pause source that reads the real control file under a fake
// clock, the pipeline over a temp repo with a worktree for each sandbox and scripted agents, the commands
// through the real CLI in a throwaway repo with a stand-in for the live run. No Docker, no model, no network.
//
//   pnpm exec tsx --test test/usage-pause.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { PlanUsage } from "../mod/hooks/run-record.ts";
import { runKit } from "./cli-spawn.ts";
import { everyPidIsTheKit, kitLikeProcess } from "./kit-process.ts";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.USAGE_CHECK = "1";
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { createSchedule } = await import("../src/schedule.ts");
const { PAUSE_FILE, holdForUsage, pauseRun, readPause, resumeRun } = await import("../src/detach.ts");
const { loadProject } = await import("../src/config.ts");
const { OperatorError } = await import("../src/errors.ts");
const { resolveSettings } = await import("../src/run-settings.ts");
const { createUsagePause, parseUsagePause, usageLimitPauseFor, usagePauseFor, usagePauseLine, usagePauseWords, usageStop } = await import("../src/usage.ts");
type Change = import("../src/schedule.ts").Change<G, string, string>;
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

type T = { id: string };
type G = { issue: string };

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-usage-pause-"));
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

// ---------------------------------------------------------------------------
// The readings, the run's lock and the usage pause over a fake clock.
// ---------------------------------------------------------------------------

/** Now, in seconds: every time below is an offset from it, so the commands, which read the real clock, agree with the fake one. */
const T0 = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const PID = 4242;

/** A Claude reading of both windows: `[percent, resetsAt]` each. */
const reading = (five: [number, number], week: [number, number], at = T0, provider: PlanUsage["provider"] = "claude"): PlanUsage => ({
  provider,
  windows: { fiveHour: { percent: five[0], resetsAt: five[1] }, week: { percent: week[0], resetsAt: week[1] } },
  at,
});
const FIVE_RESET = T0 + 2 * HOUR;
const WEEK_RESET = T0 + 30 * HOUR;

/** A project root for the control file, and the usage pause over it at `threshold`, its clock a number the test moves. */
const world = (threshold = 90) => {
  const root = mkdtempSync(join(TMP, "world"));
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  const clock = { seconds: T0 };
  const pause = createUsagePause(threshold, {
    standing: (now) => readPause(root, PID, now),
    hold: (p, now) => holdForUsage(root, PID, p, now),
    now: () => clock.seconds * 1000,
  });
  return { root, clock, pause };
};
const demands = (told: Change[]) => told.flatMap((c) => (c.kind === "demand" ? [c.n] : []));
const pauses = (told: Change[]) => told.flatMap((c) => (c.kind === "paused" ? [c] : []));

test("a reading at the threshold pauses the run for its usage, and past the window's reset it resumes and starts the next pass", async () => {
  const { root, clock, pause } = world(90);
  const log: string[] = [];
  const told: Change[] = [];
  const first = gate();
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    pause: { read: pause.source.read, pollMs: 5 },
    attempt: async (t, at) => {
      log.push("implement");
      await first.opened;
      await at.juncture("review", { suspend: async () => void log.push("sandbox closed"), resume: async () => void log.push("sandbox opened") });
      log.push("review");
      return green(t.id);
    },
    land: merged,
    host,
    tell: (c) => void told.push(c),
  });
  await until(() => log.includes("implement"), "the implement pass to start");

  // Below the threshold on both windows: the run goes on.
  assert.equal(pause.reading([reading([14, FIVE_RESET], [89, WEEK_RESET])]), undefined);
  assert.equal(readPause(root, PID, T0), undefined);

  // The weekly window reaches 90%.
  const asked = pause.reading([reading([14, FIVE_RESET], [90, WEEK_RESET])]);
  assert.deepEqual(asked, { cause: "usage", provider: "claude", window: "week", percent: 90, resumesAt: WEEK_RESET + 60 });
  assert.deepEqual(readPause(root, PID, T0), { since: T0, usage: asked }, "the control file holds the pause, its cause and when it resumes");
  assert.deepEqual(JSON.parse(readFileSync(join(root, PAUSE_FILE), "utf8")), { pid: PID, since: T0, ...asked });

  // The pass in flight finishes; at its next juncture the ticket parks and nothing else starts.
  first.open();
  await until(() => log.includes("sandbox closed"), "the ticket to park");
  const told1 = pauses(told)[0]!;
  assert.deepEqual(told1.usage, asked, "the scheduler tells why: the record's `paused` carries it");
  assert.equal(demands(told).at(-1), 0, "a run paused for usage asks for no sandbox slot");

  // A minute short of the resume time: still paused.
  clock.seconds = WEEK_RESET + 59;
  await steady(() => !log.includes("review"), "the run resumed before the window had reset and a minute passed");
  assert.ok(!told.some((c) => c.kind === "resumed"));

  // The clock reaches the resume time: the run resumes by itself, and the next pass starts.
  clock.seconds = WEEK_RESET + 60;
  const { endings } = await done;
  assert.deepEqual(log, ["implement", "sandbox closed", "sandbox opened", "review"]);
  assert.equal(told.filter((c) => c.kind === "resumed").length, 1);
  assert.equal(endings.get("1")?.kind, "landing");
});

test("the window that resets last is waited for when two are at the threshold, and a later window moves the pause on without losing its start", async () => {
  const { root, clock, pause } = world(90);
  // Both windows over: resuming at the 5-hour reset would only pause again at the weekly one.
  assert.deepEqual(pause.reading([reading([93, FIVE_RESET], [91, WEEK_RESET])]), { cause: "usage", provider: "claude", window: "week", percent: 91, resumesAt: WEEK_RESET + 60 });
  rmSync(join(root, PAUSE_FILE));

  // Paused for the 5-hour window first; the pass in flight then pushes the week over the threshold too.
  assert.equal(pause.reading([reading([95, FIVE_RESET], [60, WEEK_RESET])])?.window, "fiveHour");
  const since = readPause(root, PID, T0)?.since;
  clock.seconds = T0 + 5 * 60;
  assert.equal(pause.reading([reading([96, FIVE_RESET], [92, WEEK_RESET], T0 + 300)])?.window, "week");
  assert.deepEqual(readPause(root, PID, clock.seconds), { since, usage: { cause: "usage", provider: "claude", window: "week", percent: 92, resumesAt: WEEK_RESET + 60 } });
  // A reading that waits for an earlier reset than the standing one's changes nothing in the file.
  const before = readFileSync(join(root, PAUSE_FILE), "utf8");
  pause.reading([reading([97, FIVE_RESET], [92, WEEK_RESET], T0 + 600)]);
  assert.equal(readFileSync(join(root, PAUSE_FILE), "utf8"), before);
});

test("a window that has already reset, a provider with no window yet and a stale reading never pause the run", () => {
  const { root, clock, pause } = world(90);
  clock.seconds = FIVE_RESET + 61;
  // The 5-hour reading is from before its reset: that window has been open again for a minute.
  assert.equal(pause.reading([reading([99, FIVE_RESET], [10, WEEK_RESET], T0)]), undefined);
  assert.equal(pause.reading([{ provider: "claude" }, { provider: "codex" }]), undefined, "waiting for a first reading");
  assert.equal(existsSync(join(root, PAUSE_FILE)), false);
  // Exactly at the resume time the window counts as reset: the minute after is part of the wait.
  assert.equal(usagePauseFor([reading([99, FIVE_RESET], [10, WEEK_RESET])], 90, FIVE_RESET + 59)?.window, "fiveHour");
  assert.equal(usagePauseFor([reading([99, FIVE_RESET], [10, WEEK_RESET])], 90, FIVE_RESET + 60), undefined);
});

test("a person's pause during a usage pause stays paused after the reset, until the person resumes", async () => {
  const { root, clock, pause } = world(90);
  const probe = everyPidIsTheKit;
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${PID} token project\n`);
  const log: string[] = [];
  const told: Change[] = [];
  const first = gate();
  const done = createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    pause: { read: pause.source.read, pollMs: 5 },
    attempt: async (t, at) => {
      log.push("started");
      await first.opened;
      await at.juncture("review", { suspend: async () => void log.push("sandbox closed"), resume: async () => void log.push("sandbox opened") });
      log.push("review");
      return green(t.id);
    },
    land: merged,
    host,
    tell: (c) => void told.push(c),
  });
  await until(() => log.includes("started"), "the attempt to start");
  const asked = pause.reading([reading([14, FIVE_RESET], [95, WEEK_RESET])])!;
  first.open();
  await until(() => log.includes("sandbox closed"), "the ticket to park");

  // `sandcastle pause` during the usage pause: the pause is the person's now, since when it began.
  const taken = pauseRun(root, probe, () => T0 + 600);
  assert.deepEqual(taken, { kind: "taken over", pid: PID, since: T0, usage: asked });
  assert.deepEqual(readPause(root, PID, T0 + 600), { since: T0 }, "no cause, no time to resume at");
  await until(() => pauses(told).at(-1)?.usage === undefined, "the change of cause to be told");
  assert.ok(pauses(told).slice(0, -1).every((c) => c.usage?.window === "week"), "until then every telling of the pause named the weekly window");
  assert.equal(pauses(told).at(-1)!.since, T0, "and it is still the same pause");

  // The window resets and the minute passes: the timer has nothing to undo.
  clock.seconds = WEEK_RESET + 3600;
  await steady(() => !log.includes("review") && !told.some((c) => c.kind === "resumed"), "the run resumed on the timer, undoing a person's pause", 100);
  // Not even a new reading at the threshold moves it.
  pause.reading([reading([14, FIVE_RESET + 5 * HOUR], [95, WEEK_RESET + 7 * 24 * HOUR], clock.seconds)]);
  assert.deepEqual(readPause(root, PID, clock.seconds), { since: T0 });

  // The person resumes.
  assert.deepEqual(resumeRun(root, probe), { kind: "resumed", pid: PID, since: T0 });
  await done;
  assert.deepEqual(log, ["started", "sandbox closed", "sandbox opened", "review"]);
});

test("a person's pause that stands is never replaced by a reading, nor by an agent that hits the limit", () => {
  const { root, pause } = world(90);
  writeFileSync(join(root, PAUSE_FILE), JSON.stringify({ pid: PID, since: T0 - 60 }) + "\n");
  const before = readFileSync(join(root, PAUSE_FILE), "utf8");
  assert.equal(pause.reading([reading([14, FIVE_RESET], [99, WEEK_RESET])])?.window, "week", "the reading asks for it");
  assert.equal(readFileSync(join(root, PAUSE_FILE), "utf8"), before, "but the file stays the person's");
  assert.equal(pause.limit([reading([100, FIVE_RESET], [99, WEEK_RESET])], "claude"), true, "the ticket parks like any other");
  assert.equal(readFileSync(join(root, PAUSE_FILE), "utf8"), before);
});

test("a person's resume before the time ends the pause, and the windows then over the threshold do not pause it again until they reset", () => {
  const { root, clock, pause } = world(90);
  const probe = everyPidIsTheKit;
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${PID} token project\n`);
  const usage = [reading([91, FIVE_RESET], [95, WEEK_RESET])];
  assert.ok(pause.reading(usage));
  assert.ok(pause.source.read(), "paused");

  clock.seconds = T0 + 60;
  assert.equal(resumeRun(root, probe).kind, "resumed");
  assert.equal(pause.source.read(), undefined, "resumed, long before the reset");

  // The next readings are over the threshold still: the person said to carry on.
  assert.equal(pause.reading([reading([92, FIVE_RESET], [96, WEEK_RESET], T0 + 120)]), undefined);
  assert.equal(readPause(root, PID, T0 + 120), undefined);
  // A window is remembered by its reset time: the 5-hour one that has rolled over is a new window, and pauses at the threshold.
  assert.equal(pause.reading([reading([92, FIVE_RESET + 5 * HOUR], [96, WEEK_RESET], T0 + 120)])?.window, "fiveHour");
});

test("a pause that ended by its own time is not mistaken for a person's resume", () => {
  const { root, clock, pause } = world(90);
  assert.ok(pause.reading([reading([10, FIVE_RESET], [95, WEEK_RESET])]));
  assert.ok(pause.source.read());
  clock.seconds = WEEK_RESET + 60;
  assert.equal(pause.source.read(), undefined);
  // The same window, read again: it has reset (a stale reading), so nothing is paused for it - and nothing was remembered against it.
  assert.equal(pause.reading([reading([10, FIVE_RESET], [95, WEEK_RESET])]), undefined);
  assert.equal(readPause(root, PID, clock.seconds), undefined);
});

// ---------------------------------------------------------------------------
// An agent that hits the limit anyway: the pipeline under the scheduler.
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/**
 * A ticket's pipeline over a temp repo: each sandbox a worktree, the agents scripted by `agent(kind, call, path)`,
 * which may throw. `limitPause` is the pipeline's port for the limit (undefined: USAGE_PAUSE is off).
 */
const fixture = (agent: (kind: string, call: number, path: string, log: string) => void, limitPause: Ctx["limitPause"]) => {
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
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const events: string[] = [];
  const writes: { state?: string; note?: string | null }[] = [];
  const steps: { phase: string; waitMs?: number }[] = [];
  const waited = new Map<string, number>();
  const sandboxes: { path: string; closed: boolean }[] = [];
  const calls = new Map<string, number>();
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
        const name = opts.name ?? "";
        const kind = name.split("-")[0]!;
        events.push(`${kind} in sandbox ${sandboxes.indexOf(record)}`);
        const call = (calls.get(kind) ?? 0) + 1;
        calls.set(kind, call);
        const before = git(path, "rev-parse", "HEAD");
        // The readable log the library writes, which the run reads to tell a spent allowance from any other failure.
        const log = join(root, `.sandcastle/logs/agent-issue-7-${name}.log`);
        writeFileSync(log, "pass finished\n");
        agent(kind, call, path, log);
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
    runId: "2026-10-06T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async (box) => (events.push(`gate in sandbox ${sandboxes.findIndex((s) => s.path === box.worktreePath)}`), GREEN),
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, phase, fn) => {
      const result = await fn();
      steps.push({ phase, waitMs: (result as { waitMs?: number } | undefined)?.waitMs });
      return result;
    },
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
    ...(limitPause ? { limitPause } : {}),
  });
  const issue = { id: "7", title: "seven", body: "" } as Parameters<typeof pipeline>[0];
  return { root, pipeline, issue, events, writes, steps, waited, sandboxes };
};

/** Claude Code's own words when the plan's allowance is spent, as the log's last line. */
const LIMIT_WORDS = "Claude AI usage limit reached|1790108400";
/** A log whose last lines are something else: whatever an earlier line said, that pass did not hit the limit. */
const OTHER_FAILURE = `${LIMIT_WORDS}\n${Array.from({ length: 10 }, (_, i) => `then the agent went on (${i})`).join("\n")}\nIdle timeout\n`;
/** An attempt's argument for a pipeline run on its own: the run is not paused, so every juncture returns at once. */
const NO_PAUSE = { juncture: async () => {} };

test("a pass that hits the limit with USAGE_PAUSE set pauses the run until the reset, and runs the same pass again on the resume", async () => {
  const { root, clock, pause } = world(90);
  const asked: string[] = [];
  const f = fixture(
    (kind, call, path, log) => {
      if (kind !== "impl") return;
      commit(path, `impl-${call}.txt`, `${call}\n`);
      // The first implement pass spends the last of the week's allowance and dies with it, one commit in.
      if (call === 1) {
        writeFileSync(log, `working\n${LIMIT_WORDS}\n`);
        throw new Error("agent exited with code 1");
      }
    },
    (phase) => {
      asked.push(phase);
      return pause.limit([reading([40, FIVE_RESET], [100, WEEK_RESET])], "claude");
    },
  );
  const told: Change[] = [];
  const ended: { outcome?: Awaited<ReturnType<typeof f.pipeline>> } = {};
  // Read through a function: an assertion on the field would narrow it for the rest of the test, though the attempt sets it later.
  const outcomeNow = () => ended.outcome;
  const done = quietly(() =>
    createSchedule<T, G, string, string>({ tickets: [f.issue] }).run({
      workers: 1,
      pause: { read: pause.source.read, pollMs: 5 },
      attempt: async (_t, at) => {
        ended.outcome = await f.pipeline(f.issue, at);
        return { kind: "pipeline", outcome: ended.outcome.status };
      },
      land: merged,
      host,
      tell: (c) => void told.push(c),
    }),
  );
  await until(() => f.writes.some((w) => w.state === "paused"), "the ticket to park");
  const head = git(f.root, "rev-parse", "--short", "agent/issue-7");
  assert.deepEqual(asked, ["implement"]);
  assert.deepEqual(readPause(root, PID, T0), { since: T0, usage: { cause: "usage", provider: "claude", window: "week", percent: 100, resumesAt: WEEK_RESET + 60 } }, "the run paused for the week, not stopped");
  assert.deepEqual(f.events, ["impl in sandbox 0"]);
  assert.equal(f.sandboxes[0]?.closed, true, "the sandbox closed, as at any juncture");
  assert.deepEqual(f.writes.find((w) => w.state === "paused"), { state: "paused", note: `before implement at ${head}` });
  assert.equal(git(f.root, "rev-list", "--count", "main..agent/issue-7"), "1", "the commit the pass made before it hit the limit stays on the branch");
  assert.equal(outcomeNow(), undefined, "the pipeline has not ended");
  assert.equal(demands(told).at(-1), 0);
  await steady(() => f.events.length === 1 && f.sandboxes.length === 1, "a pass began while the run waited for the window", 100);

  clock.seconds = WEEK_RESET + 60;
  const { lines } = await done;
  assert.equal(outcomeNow()?.status, "green");
  assert.deepEqual(f.events, ["impl in sandbox 0", "impl in sandbox 1", "review in sandbox 1", "gate in sandbox 1"], "implement runs again in a fresh sandbox, then the pipeline goes on");
  assert.equal(git(f.root, "rev-list", "--count", "main..agent/issue-7"), "2", "on the same branch: the second pass builds on the first's commit");
  assert.ok(lines.some((l) => /#7: the implement pass hit the plan's usage limit - the run pauses until the window resets/.test(l)), lines.join("\n"));
  // The time parked is no pass's work: the step reports it as a wait, and the ticket's usual time leaves it out.
  const implement = f.steps.find((s) => s.phase === "implement");
  assert.ok((implement?.waitMs ?? 0) >= 100, `the implement step's wait: ${JSON.stringify(implement)}`);
  assert.equal(f.waited.get("7"), undefined, "which the step's own timer counts once: this fixture's timer does not");
  assert.deepEqual(f.writes.filter((w) => w.state === "implement").at(-1)?.note, "running the pass again after the plan's usage window reset");
});

test("without USAGE_PAUSE, or with no reading to say when the window resets, a pass that hits the limit fails as it always did", async () => {
  const hit = (kind: string, _call: number, _path: string, log: string) => {
    if (kind !== "impl") return;
    writeFileSync(log, `working\n${LIMIT_WORDS}\n`);
    throw new Error("agent exited with code 1");
  };
  // Off: the pipeline has no port for the limit.
  const off = fixture(hit, undefined);
  await quietly(() => assert.rejects(off.pipeline(off.issue, NO_PAUSE), /agent exited with code 1/));
  assert.deepEqual(off.events, ["impl in sandbox 0"]);

  // On, but the readings name no window still to reset (an API key has none): the run cannot say when to resume.
  const { pause, root } = world(90);
  const asked: string[] = [];
  const none = fixture(hit, (phase) => (asked.push(phase), pause.limit([], "claude")));
  await quietly(() => assert.rejects(none.pipeline(none.issue, NO_PAUSE), /agent exited with code 1/));
  assert.deepEqual(asked, ["implement"]);
  assert.deepEqual(none.events, ["impl in sandbox 0"]);
  assert.equal(readPause(root, PID, T0), undefined, "nothing was paused");
});

test("a pass that fails for another reason than the limit is not waited out, whatever an earlier line of its log said", async () => {
  const { pause, root } = world(90);
  const asked: string[] = [];
  const f = fixture(
    (kind, _call, _path, log) => {
      if (kind !== "impl") return;
      writeFileSync(log, OTHER_FAILURE);
      throw new Error("idle timeout");
    },
    (phase) => (asked.push(phase), pause.limit([reading([100, FIVE_RESET], [100, WEEK_RESET])], "claude")),
  );
  await quietly(() => assert.rejects(f.pipeline(f.issue, NO_PAUSE), /idle timeout/));
  assert.deepEqual(asked, [], "the run was not asked to pause");
  assert.equal(readPause(root, PID, T0), undefined);
});

// ---------------------------------------------------------------------------
// The limit's pause, as a pure choice of window.
// ---------------------------------------------------------------------------

test("an agent that hits the limit pauses for the window nearest to spent, at 100%, and for the later reset when two tie", () => {
  assert.deepEqual(usageLimitPauseFor([reading([100, FIVE_RESET], [92, WEEK_RESET])], T0), { cause: "usage", provider: "claude", window: "fiveHour", percent: 100, resumesAt: FIVE_RESET + 60 });
  assert.deepEqual(usageLimitPauseFor([reading([70, FIVE_RESET], [97, WEEK_RESET])], T0), { cause: "usage", provider: "claude", window: "week", percent: 100, resumesAt: WEEK_RESET + 60 }, "the last reading was stale: the week it was nearest");
  assert.equal(usageLimitPauseFor([reading([100, FIVE_RESET], [100, WEEK_RESET])], T0)?.window, "week", "both spent: both must reset");
  // Whose agent it was: a Claude pass is waited out on Claude's plan, whatever Codex's windows say.
  const both = [reading([100, FIVE_RESET], [10, WEEK_RESET], T0, "codex"), reading([10, FIVE_RESET + HOUR], [96, WEEK_RESET + HOUR], T0, "claude")];
  assert.equal(usageLimitPauseFor(both, T0, "claude")?.provider, "claude");
  assert.equal(usageLimitPauseFor(both, T0, "codex")?.provider, "codex");
  // No reading, an entry still waiting for its first, or only windows that have reset: nothing to resume at.
  assert.equal(usageLimitPauseFor([], T0), undefined);
  assert.equal(usageLimitPauseFor([{ provider: "claude" }], T0), undefined);
  assert.equal(usageLimitPauseFor([reading([100, FIVE_RESET], [100, WEEK_RESET])], WEEK_RESET + 60), undefined);
});

test("the pause says what it waits for in the status view's words", () => {
  assert.equal(usagePauseWords({ provider: "claude", window: "week", percent: 95 }), "weekly usage 95%");
  assert.equal(usagePauseWords({ provider: "claude", window: "fiveHour", percent: 93 }), "5-hour usage 93%");
  assert.equal(usagePauseWords({ provider: "codex", window: "week", percent: 100 }), "Codex weekly usage 100%");
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

test("`sandcastle pause` on a run paused for usage says the pause is the person's now, and `resume` says what it ended", () => {
  const root = project();
  const run = kitLikeProcess();
  try {
    writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${run.pid} token project\n`);
    const now = Math.floor(Date.now() / 1000);
    const usage = { cause: "usage", provider: "claude", window: "week", percent: 95, resumesAt: now + 3 * 24 * HOUR } as const;
    holdForUsage(root, run.pid, usage, now - 60);
    assert.deepEqual(readPause(root, run.pid), { since: now - 60, usage });

    const pause = kit(root, "pause");
    assert.equal(pause.status, 0, pause.err);
    assert.match(pause.out, /^The run \(pid \d+\) paused itself at \d\d:\d\d for its plan's usage \(weekly usage 95%, it would resume at (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d\)\. The pause is yours now: it stays until `sandcastle resume`, whatever the window does\.$/);
    assert.deepEqual(readPause(root, run.pid), { since: now - 60 });
    assert.match(kit(root, "pause").out, /is already paused, since \d\d:\d\d\. `sandcastle resume` continues it\.$/, "a second pause is the person's, as ever");

    // The run takes its own pause again, as it would after a resume.
    rmSync(join(root, PAUSE_FILE));
    holdForUsage(root, run.pid, usage, now - 60);
    const resume = kit(root, "resume");
    assert.equal(resume.status, 0, resume.err);
    assert.match(resume.out, /^Resuming the run \(pid \d+, paused since \d\d:\d\d\): each paused ticket goes on from its next phase\.\nIt was paused for its plan's usage \(weekly usage 95%, until (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d\)/);
    assert.equal(existsSync(join(root, PAUSE_FILE)), false);
  } finally {
    run.kill();
  }
});

test("a usage pause past its time is no pause: the run, `pause` and `resume` all read it so", () => {
  const root = project();
  const run = kitLikeProcess();
  try {
    writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${run.pid} token project\n`);
    const now = Math.floor(Date.now() / 1000);
    holdForUsage(root, run.pid, { cause: "usage", provider: "claude", window: "fiveHour", percent: 92, resumesAt: now - 1 }, now - HOUR);
    assert.equal(readPause(root, run.pid), undefined);
    assert.match(kit(root, "resume").out, /is not paused\.$/);
    holdForUsage(root, run.pid, { cause: "usage", provider: "claude", window: "fiveHour", percent: 92, resumesAt: now - 1 }, now - HOUR);
    assert.match(kit(root, "pause").out, /^Pausing the run/, "a person can pause a run whose usage pause is over");
    assert.deepEqual(readPause(root, run.pid)?.usage, undefined);
  } finally {
    run.kill();
  }
});

test("the control file's cause is read like a file in a repository: one that does not state it fully is a person's pause", () => {
  const root = project();
  mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
  const write = (body: object) => writeFileSync(join(root, PAUSE_FILE), JSON.stringify({ pid: PID, since: T0, ...body }));
  write({ cause: "usage", provider: "claude", window: "week", percent: 95, resumesAt: T0 + 100 });
  assert.equal(readPause(root, PID, T0)?.usage?.window, "week");
  assert.equal(readPause(root, PID, T0 + 100), undefined, "at its time it is over");
  for (const bad of [{ cause: "usage" }, { cause: "usage", provider: "claude", window: "month", percent: 95, resumesAt: T0 + 100 }, { cause: "usage", provider: "claude", window: "week", percent: "95", resumesAt: T0 + 100 }, { cause: "usage", provider: "gemini", window: "week", percent: 95, resumesAt: T0 + 100 }]) {
    write(bad);
    assert.deepEqual(readPause(root, PID, T0 + 1000_000), { since: T0 }, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// The guard: the agents' readings before the endpoint.
// ---------------------------------------------------------------------------

/** What the endpoint would answer, counted: a guard that asks it with a fresh agent reading has failed. */
const endpoint = (windows: Record<string, { utilization: number }>) => {
  const real = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => (requests.push(String(url)), new Response(JSON.stringify(windows), { status: 200 }))) as unknown as typeof fetch;
  return { requests, restore: () => void (globalThis.fetch = real) };
};
const noLogin = { keychain: () => undefined, file: () => undefined };
const ENV = { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" };

test("USAGE_CHECK with a fresh agent reading makes no endpoint request, and stops at the same threshold", async () => {
  const api = endpoint({ five_hour: { utilization: 10 } });
  try {
    const now = () => (T0 + 300) * 1000;
    const claude = (week: number, at = T0): PlanUsage => reading([14, FIVE_RESET], [week, WEEK_RESET], at);
    // 93% of the week, read five minutes ago: the guard's stop, from the agent's own reading.
    assert.equal(await usageStop(ENV, noLogin, () => claude(93), now), "plan usage seven_day 93% reached USAGE_STOP=90%");
    // Under the threshold: carry on.
    assert.equal(await usageStop(ENV, noLogin, () => claude(40), now), undefined);
    // Both windows over: both named, as the endpoint's reading names them.
    assert.equal(await usageStop(ENV, noLogin, () => reading([91, FIVE_RESET], [99, WEEK_RESET], T0), now), "plan usage five_hour 91% · seven_day 99% reached USAGE_STOP=90%");
    // Nothing needs a credential: a login that has expired, or none at all, makes no difference to a fresh reading.
    assert.equal(await usageStop({}, noLogin, () => claude(93), now), "plan usage seven_day 93% reached USAGE_STOP=90%");
    // A window that has reset since the reading is spent no more.
    assert.equal(await usageStop(ENV, noLogin, () => reading([14, FIVE_RESET], [99, T0 + 200], T0), now), undefined);
    assert.deepEqual(api.requests, [], "the endpoint was never asked");
  } finally {
    api.restore();
  }
});

test("USAGE_CHECK asks the endpoint before the first agent reading, and once the newest is ten minutes old", async () => {
  const api = endpoint({ five_hour: { utilization: 96 }, seven_day: { utilization: 12 } });
  try {
    // Before the first reading: an entry still waiting for one, or none.
    assert.match((await usageStop(ENV, noLogin, () => ({ provider: "claude" }), () => T0 * 1000)) ?? "", /^plan usage five_hour 96% reached USAGE_STOP=90%$/);
    assert.equal(api.requests.length, 1);
    // Nine minutes old: the agent's reading still counts - 12% - and the endpoint's cached 96% is not read.
    assert.equal(await usageStop(ENV, noLogin, () => reading([14, FIVE_RESET], [12, WEEK_RESET], T0), () => (T0 + 9 * 60) * 1000), undefined);
    assert.equal(api.requests.length, 1);
    // Ten minutes old: the endpoint decides again (its own reading is cached as long, so only one request was ever made here).
    assert.match((await usageStop(ENV, noLogin, () => reading([14, FIVE_RESET], [12, WEEK_RESET], T0), () => (T0 + 10 * 60) * 1000)) ?? "", /five_hour 96%/);
  } finally {
    api.restore();
  }
});

// ---------------------------------------------------------------------------
// The setting.
// ---------------------------------------------------------------------------

test("USAGE_PAUSE takes 1 to 100 and refuses anything else, as USAGE_STOP does", () => {
  for (const ok of ["1", "90", "100", "87.5"]) assert.equal(parseUsagePause(ok), Number(ok), ok);
  for (const off of [undefined, ""]) assert.equal(parseUsagePause(off), undefined, `${off} is off`);
  for (const bad of ["0", "101", "-5", "abc", "0.5", "NaN", "150"]) {
    assert.throws(() => parseUsagePause(bad), (e) => e instanceof OperatorError && e.message === `USAGE_PAUSE=${bad} - expected 1 to 100.`, bad);
  }
  assert.equal(parseUsagePause(undefined, 80), 80, "the project's `usagePause`");
  assert.equal(parseUsagePause("95", 80), 95, "the environment beats the project config");
  assert.throws(() => parseUsagePause(undefined, 150), OperatorError);
  assert.throws(() => parseUsagePause(undefined, "90"), OperatorError);
});

test("the run's settings carry the threshold from the environment or the project config, and nothing when it is off", () => {
  const resolve = (env: Record<string, string | undefined>, usagePause?: unknown) => resolveSettings({ env, project: { usagePause }, machine: {} });
  assert.equal(resolve({}).usagePause, undefined);
  assert.ok(!("usagePause" in resolve({})), "no key at all: a run that does not pause keeps its settings as they were");
  assert.equal(resolve({ USAGE_PAUSE: "90" }).usagePause, 90);
  assert.equal(resolve({}, 85).usagePause, 85);
  assert.equal(resolve({ USAGE_PAUSE: "70" }, 85).usagePause, 70);
  assert.equal(resolve({ USAGE_PAUSE: "" }, 85).usagePause, 85, "an empty variable is unset");
  assert.throws(() => resolve({ USAGE_PAUSE: "0" }), OperatorError);
  assert.throws(() => resolve({}, 101), OperatorError);
});

const refusedRun = (env: Record<string, string>) => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-usage-pause-cli-"));
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd });
  mkdirSync(join(cwd, ".sandcastle"));
  writeFileSync(join(cwd, ".sandcastle/config.ts"), 'export default { name: "t", gates: [{ name: "g", command: "true" }] };\n');
  const r = runKit(["run"], {
    cwd,
    env: { ...process.env, ...env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-test-")), GIT_CEILING_DIRECTORIES: tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  rmSync(cwd, { recursive: true, force: true });
  return r;
};

test("a bad USAGE_PAUSE is refused before the run does anything", () => {
  const r = refusedRun({ USAGE_PAUSE: "abc" });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("USAGE_PAUSE=abc - expected 1 to 100."), r.stderr);
  // Nothing before the refusal: no queue listed, no versions resolved, no preflight.
  assert.doesNotMatch(r.stdout, /issue\(s\)|Claude Code \d|Preflight|No .* tickets/, r.stdout);
  assert.ok(refusedRun({ USAGE_PAUSE: "101" }).stderr.includes("USAGE_PAUSE=101 - expected 1 to 100."));
});

const load = (body: string) => {
  const root = mkdtempSync(join(TMP, "config"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), body);
  return loadProject(root);
};
const config = (extra: string) => `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }], ${extra} };\n`;

test("a bad `usagePause` in the project config is refused with the key named, and a good one loads", async () => {
  for (const bad of ["150", "0", "0.5", '"high"', "true", "null"]) {
    await assert.rejects(load(config(`usagePause: ${bad}`)), (e: Error) => e instanceof OperatorError && /`usagePause` must be a number from 1 to 100 \(the percent of a plan window at which a run pauses\), not /.test(e.message), bad);
  }
  assert.equal((await load(config("usagePause: 90"))).usagePause, 90);
  assert.equal((await load(config(""))).usagePause, undefined);
  // A typo is the unknown-key refusal it always was.
  await assert.rejects(load(config("usagePaus: 90")), /unknown key `usagePaus` - did you mean `usagePause`\?/);
});

test("the start line says the setting, and says when the run has no plan usage to pause on", () => {
  assert.equal(usagePauseLine(90, ["claude"]), "Usage pause: at 90%, resumes at the window's reset");
  assert.equal(usagePauseLine(75, ["claude", "codex"]), "Usage pause: at 75%, resumes at the window's reset");
  assert.match(usagePauseLine(90, []), /^Usage pause: at 90%, but this run reads no plan usage .*so it never pauses for it$/);
});
