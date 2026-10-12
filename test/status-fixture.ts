// Project fixtures for the status view, shared by every test that holds a view to its facts: the
// run record, logs, branches, the queue a fake `sandcastle` answers and the containers a fake `docker`
// reports, with a fixed clock and zone, so a frame is the same on every machine.
//
// The clock is `SANDCASTLE_TEST_NOW` (epoch seconds) and the zone `TZ`. The bash view reads the time
// through `date`, so the fixture's `bin/` holds a `date` that answers for that clock; the TypeScript
// view gets the same clock from a preload (test/status-run.ts), so neither view needs a seam of its own.
// `nproc` and `sysctl` answer too: the CPU column's "cores of N" would otherwise show the machine's.
//
// Three projects, each built by `buildFixture(kind, dir)`:
//   live    a run whose record holds a ticket in every ticket state, with inferred rows beside them (a
//           finished branch, a leftover, an orphaned sandbox, a ticket outside the run), the settings,
//           plan usage and pool rows, one sandbox container
//   legacy  an older orchestrator's live run, which kept no `tickets`: its rows come from branches,
//           logs and the `active` and `waiting` lists, and a worktree whose log went quiet is `stalled`
//   ended   a run that finished: every row inferred from git, the logs and outcomes.json
//
// A fixture is a directory the caller owns (a temp directory) and a process standing in for the live run,
// which `stop()` ends.

import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { TICKET_STATES } from "../mod/hooks/run-record.ts";
import { kitLikeProcess } from "./kit-process.ts";

/** 2026-10-10 12:00:00 UTC, in epoch seconds: the clock every fixture frame is drawn at. */
export const NOW = Date.UTC(2026, 9, 10, 12, 0, 0) / 1000;
/** A POSIX zone string (+1 hour, no daylight time), so it needs no zone database: the frame's clock reads 13:00:00. */
export const TZ = "CET-1";
/** The project's name, as the header shows it. */
export const NAME = "fixture";
/** The base branch. */
export const BASE = "main";

export type FixtureKind = "live" | "legacy" | "ended";

export type Fixture = {
  kind: FixtureKind;
  /** The project root, with a space in its path: a view once split mount paths on spaces. */
  root: string;
  /** The directory the fakes are in, to put first on `PATH`. */
  bin: string;
  /** A directory for `XDG_CACHE_HOME`: the pool's slots and the Herdr marker live under it. */
  cache: string;
  /** A FIFO nothing writes to: an armed fake (`hang`) blocks reading it. */
  hang: string;
  /** Where every fake appends its pid and name for each call, one line each (test/status-run.ts reads it for the orphan check). */
  pids: string;
  /** How many of those lines were there when the latest view was started: the orphan check looks at the lines after. */
  mark: number;
  /** The ticket ids worth naming, by what they show: `tickets.red` is the id of the ticket in the `red` state. */
  tickets: Record<string, string>;
  /** The tickets whose worktree a sandbox container runs on (the fake `docker` reports one container each), and the one working hard. */
  containers: string[];
  hot: string;
  /** Ends the process standing in for the live run. */
  stop: () => void;
};

const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

/** Where `name` is on the `PATH` the test runs with: the fakes call the real tool by this path. */
const realTool = (name: string): string => {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  if (!found) throw new Error(`${name} is not on PATH`);
  return found;
};

/**
 * The fakes. Each logs its own pid to `$FAKE_PIDS` (`$$`: the process stays that pid through an `exec`)
 * before it answers, so a test can ask afterwards whether any is still running. A fake named by `FAKE_HANG` then
 * blocks (on the FIFO `FAKE_HANG_FIFO`, which nothing writes to) until it is killed: a command in flight. It
 * ignores a hangup: the pty's teardown would otherwise end it, and hide the orphan a view that did not
 * stop its children leaves.
 * `FAKE_QUEUE_FILE` is the queue's answer (a JSON list), `FAKE_QUEUE_FAIL` a failure's message, and
 * `FAKE_DOCKER` the project root whose sandbox containers `docker` reports, `FAKE_DOCKER_TICKETS` the tickets they run, `FAKE_DOCKER_HOT` the one working hard.
 */
const writeFakes = (bin: string) => {
  const log = (name: string) =>
    `[ -n "\${FAKE_PIDS:-}" ] && echo "$$ ${name}" >>"$FAKE_PIDS"\n[ -e "$FAKE_HANG_FIFO.${name}" ] && { rm -f "$FAKE_HANG_FIFO.${name}"; trap '' HUP; exec cat "$FAKE_HANG_FIFO"; }\n`;
  script(
    join(bin, "sandcastle"),
    `#!/bin/sh
${log("sandcastle")}[ -n "\${FAKE_QUEUE_FAIL:-}" ] && { echo "$FAKE_QUEUE_FAIL" >&2; exit 1; }
if [ -n "\${FAKE_QUEUE_FILE:-}" ] && [ -f "$FAKE_QUEUE_FILE" ]; then cat "$FAKE_QUEUE_FILE"; else echo '[]'; fi
`,
  );
  script(
    join(bin, "docker"),
    `#!/bin/sh
${log("docker")}[ -n "\${FAKE_DOCKER:-}" ] || exit 1
case "$1" in
  ps) for t in $FAKE_DOCKER_TICKETS; do echo "c$t"; done ;;
  inspect)
    shift
    for id in "$@"; do
      case "$id" in c*) printf '/sandcastle-%s|/tmp/cache|%s/.sandcastle/worktrees/agent-issue-%s\\n' "$id" "$FAKE_DOCKER" "\${id#c}" ;; esac
    done ;;
  stats)
    shift
    for id in "$@"; do
      case "$id" in c*) if [ "\${id#c}" = "\${FAKE_DOCKER_HOT:-}" ]; then echo "sandcastle-$id|700.00%|2.1GiB / 11.73GiB"; else echo "sandcastle-$id|150.00%|275.8MiB / 11.73GiB"; fi ;; esac
    done ;;
esac
`,
  );
  // The view never calls gh itself (the queue is `sandcastle queue`), but a call that appeared would be a process to account for.
  script(join(bin, "gh"), `#!/bin/sh\n${log("gh")}exit 1\n`);
  // git is the real one, called through this: the same pid, since exec keeps it.
  script(join(bin, "git"), `#!/bin/sh\n${log("git")}exec "${realTool("git")}" "$@"\n`);
  script(join(bin, "nproc"), "#!/bin/sh\necho 8\n");
  script(join(bin, "sysctl"), "#!/bin/sh\nexit 1\n");
  // The time: a format asked of `date` with no time given is the fixed one's; any other call (a time given, -u, BSD's -j) is the real date's.
  const date = realTool("date");
  script(
    join(bin, "date"),
    `#!/bin/sh
case "\${1:-}" in
  +*)
    if [ -n "\${SANDCASTLE_TEST_NOW:-}" ]; then
      if "${date}" -d @0 +%s >/dev/null 2>&1; then exec "${date}" -d "@$SANDCASTLE_TEST_NOW" "$@"; fi
      exec "${date}" -r "$SANDCASTLE_TEST_NOW" "$@"
    fi ;;
esac
exec "${date}" "$@"
`,
  );
};

const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, "Z");

/** A project's git: identity and dates fixed, so a commit's time (the landing check reads it) is the same each build. */
const gitIn = (root: string) => (...args: string[]) =>
  execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: `${NOW - 86400} +0000`, GIT_COMMITTER_DATE: `${NOW - 86400} +0000` },
  });

type Log = { phase: string; id: string; last: string; ago: number };

/** The project's tree: a base commit, a worktrees directory, the logs. Returns what a builder needs to add branches and logs. */
const project = (root: string) => {
  const logs = join(root, ".sandcastle", "logs");
  mkdirSync(logs, { recursive: true });
  mkdirSync(join(root, ".sandcastle", "worktrees"), { recursive: true });
  const git = gitIn(root);
  git("init", "-q", "-b", BASE);
  git("commit", "-q", "--allow-empty", "-m", "base");
  // The base has an upstream as of now: what lands on it after this is unpushed (the header says how many).
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("config", "remote.origin.url", "https://example.invalid/fixture.git");
  git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git("config", "branch.main.remote", "origin");
  git("config", "branch.main.merge", "refs/heads/main");
  /** A branch for the ticket with `commits` commits on it, left standing. */
  const branch = (id: string, commits: number) => {
    git("checkout", "-q", "-b", `agent/issue-${id}`, BASE);
    for (let i = 1; i <= commits; i++) git("commit", "-q", "--allow-empty", "-m", `work ${i} on ${id}`);
    git("checkout", "-q", BASE);
  };
  /** A ticket landed the way the orchestrator does it: a merge commit named for the branch, which is then deleted. */
  const land = (id: string, part = false) => {
    branch(id, 1);
    git("merge", "-q", "--no-ff", "-m", `Merge agent/issue-${id} (${part ? "part of" : "closes"} #${id})`, `agent/issue-${id}`);
    git("branch", "-q", "-D", `agent/issue-${id}`);
  };
  const log = ({ phase, id, last, ago }: Log) => {
    const path = join(logs, `agent-issue-${id}-${phase}-${id}.log`);
    writeFileSync(path, `Agent started\n${last}\n`);
    utimesSync(path, NOW - ago, NOW - ago);
  };
  const worktree = (id: string) => mkdirSync(join(root, ".sandcastle", "worktrees", `agent-issue-${id}`), { recursive: true });
  const json = (name: string, value: unknown) => writeFileSync(join(logs, name), JSON.stringify(value));
  return { git, branch, land, log, worktree, json };
};

/** Arms the fake `name` (docker, gh, git or sandcastle) to block the next time it is called. */
export const hang = (fixture: Fixture, name: string) => writeFileSync(`${fixture.hang}.${name}`, "");

/**
 * Lets the blocked fake go: it reads the end of the FIFO and answers as if it had found nothing. The FIFO is
 * opened without blocking and retried until the fake has it open (a write end with no reader is refused), so a fake that is gone does not hang the test.
 */
export const release = async (fixture: Fixture, ms = 10_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      closeSync(openSync(fixture.hang, constants.O_WRONLY | constants.O_NONBLOCK));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENXIO" || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

/** The file `FAKE_QUEUE_FILE` names: the queue the fake `sandcastle` answers with, kept beside the fixture's cache. */
export const queueFile = (fixture: Fixture) => join(fixture.cache, "queue.json");

type QueueEntry = { id: string; blockedOn?: string[]; updated?: string | null };

/** The queue as the tracker lists it (`updated` null: nobody touched the ticket lately). */
const writeQueue = (fixture: Fixture, entries: QueueEntry[]) =>
  writeFileSync(queueFile(fixture), JSON.stringify(entries.map((e) => ({ id: e.id, title: `ticket ${e.id}`, updated: e.updated ?? null, blockedOn: e.blockedOn ?? [] }))));

const WORKING = ["setup", "implement", "resolve", "review", "cross-review", "gates", "repair", "landing"];

/**
 * A ticket in every state. The id is the state's position in `TICKET_STATES` (101 is the first), so a
 * test reads `fixture.tickets.red` rather than counting. Notes are what a run would write for the state.
 */
const liveTickets = () => {
  const notes: Record<string, string> = {
    setup: "preparing the sandbox",
    resolve: "merging main into the branch",
    gates: "2/3 pytest",
    repair: "attempt 1 of 2",
    ready: "gated green, waits to land",
    paused: "resumes with review",
    blocked: "waits for #99 to close",
    merged: "merged and closed",
    held: "human merge: .github/",
    conflict: "conflicts in src/a.ts with #101",
    red: "pytest red: test_cart",
    nochange: "nothing to change",
    uncommitted: "uncommitted files left in the sandbox",
    crashed: "agent exited with code 1",
    "not landed": "landing gate failed twice",
    withdrawn: "closed while the run was going",
    stopped: "stopped before the review",
    skipped: "not in the milestone",
  };
  const ids: Record<string, string> = {};
  const record: Record<string, Record<string, unknown>> = {};
  TICKET_STATES.forEach((state, i) => {
    const id = String(101 + i);
    ids[state] = id;
    record[id] = {
      state,
      since: WORKING.includes(state) ? NOW - 90 - i * 20 : NOW - 600 - i * 30,
      started: NOW - 3000 - i * 100,
      order: state === "queued" ? 1 : undefined,
      note: notes[state],
      tokens: WORKING.includes(state) || state === "merged" ? `${1 + i}.${i % 10}M in / ${40 + i}k out` : undefined,
      requeued: state === "conflict" ? "requeued after conflict with #101" : undefined,
    };
  });
  return { ids, record };
};

/** A slot the machine-wide pool holds for the live run: one lock file per slot, its owner's pid first. */
const slot = (cache: string, pool: string, n: number, pid: number) => {
  const dir = join(cache, "sandcastle-kit", "slots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pool}-${n}.lock`), `${pid} token run label\n`);
};

const SETTINGS = {
  autonomy: 2,
  turn: 1,
  cap: 3,
  repair: 2,
  concurrency: 3,
  crossReview: true,
  crossReviewModel: "gpt-5",
  crossReviewEffort: "high",
  usageGuard: true,
  usageStop: 95,
  usagePause: 90,
  keepWarm: true,
};

const live = (fixture: Fixture, p: ReturnType<typeof project>, run: ChildProcess) => {
  const { ids, record } = liveTickets();
  fixture.tickets = ids;
  // Branches and logs for the tickets that have a worktree or a result on disk.
  for (const [state, id] of Object.entries(ids)) {
    if (["setup", "implement", "resolve", "review", "cross-review", "gates", "repair"].includes(state)) {
      const phase = state === "implement" ? "impl" : state === "cross-review" ? "review-codex" : state;
      p.branch(id, 2);
      p.log({ phase, id, last: `Edit(src/${id}.ts)`, ago: 30 });
    } else if (["ready", "landing", "held", "red", "conflict", "uncommitted", "not landed", "stopped"].includes(state)) {
      p.branch(id, 1);
    }
  }
  p.land(ids.merged!);
  p.worktree(ids.implement!);
  // Rows the record does not hold: a finished branch of this run (it is in the run's `issues`), a leftover of an
  // earlier run, one of an earlier run that is labelled again, an orphan (a sandbox on a worktree no live run owns).
  p.branch("201", 1);
  p.log({ phase: "impl", id: "201", last: "<promise>COMPLETE</promise>", ago: 2400 });
  p.branch("202", 3);
  p.log({ phase: "impl", id: "202", last: "No commits to sync out.", ago: 90000 });
  p.branch("203", 2);
  p.log({ phase: "impl", id: "203", last: "Edit(src/old.ts)", ago: 100000 });
  p.branch("204", 1);
  p.worktree("204");
  p.log({ phase: "impl", id: "204", last: "Bash(pnpm test)", ago: 3000 });
  p.json("run.json", {
    orchestrator: NAME,
    pid: run.pid,
    startedAt: iso(NOW - 7200),
    stage: "running",
    models: "implement sonnet-5-5/high, review opus-5-5/high",
    concurrency: 3,
    load: { concurrency: 3, tickets: 24 },
    typical: { gates: 300, issue: 900, "landing gates": 120 },
    issues: [...Object.values(ids), "201"],
    versions: { kit: "0.14.0", claude: "2.1.0", codex: "0.9.0" },
    tokens: "41M in / 600k out",
    demand: 3,
    share: 3,
    settings: SETTINGS,
    usage: [{ provider: "claude", windows: { fiveHour: { percent: 42, resetsAt: NOW + 7200 }, week: { percent: 61, resetsAt: NOW + 3 * 86400 } }, at: NOW - 60 }],
    tickets: record,
  });
  p.json("outcomes.json", { "202": { run: iso(NOW - 3 * 86400), kind: "green", text: "gated green, not landed" } });
  writeQueue(fixture, [{ id: ids.queued! }, { id: ids.blocked!, blockedOn: ["#99"] }, { id: "201" }, { id: "203" }, { id: "301", blockedOn: ["#101"] }, { id: "302" }]);
  slot(fixture.cache, "sandboxes", 1, run.pid!);
  slot(fixture.cache, "sandboxes", 2, run.pid!);
  slot(fixture.cache, "gates", 1, run.pid!);
  fixture.containers = [ids.implement!, "204"];
  fixture.hot = "204";
};

const legacy = (fixture: Fixture, p: ReturnType<typeof project>, run: ChildProcess) => {
  // An older orchestrator's record: the run's issues, what is active and what waits, and no `tickets`.
  for (const id of ["301", "302", "303"]) {
    p.branch(id, 2);
    p.worktree(id);
  }
  p.log({ phase: "impl", id: "301", last: "Edit(src/a.ts)", ago: 45 });
  p.log({ phase: "gates", id: "302", last: "pytest: 2 passed", ago: 120 });
  p.log({ phase: "review", id: "303", last: "Read(src/b.ts)", ago: 2400 });
  p.json("run.json", {
    orchestrator: NAME,
    pid: run.pid,
    startedAt: iso(NOW - 5400),
    models: "implement sonnet-5-5/high",
    issues: ["301", "302", "303", "304", "305"],
    active: { "301": { phase: "implement", since: NOW - 300 }, "302": { phase: "gates", since: NOW - 200 }, "303": { phase: "review", since: NOW - 2400 } },
    waiting: [{ issue: "305", on: ["304"] }],
  });
  writeQueue(fixture, [{ id: "304" }, { id: "305" }, { id: "306" }]);
  fixture.containers = ["301"];
  fixture.tickets = { implement: "301", gates: "302", stalled: "303" };
};

const ended = (fixture: Fixture, p: ReturnType<typeof project>) => {
  const started = iso(NOW - 10800);
  const outcome = (kind: string, text: string) => ({ run: started, kind, text });
  const earlier = iso(NOW - 4 * 86400);
  const outcomes: Record<string, unknown> = {};
  const tickets: Record<string, unknown> = {};
  // One ticket per ending, its branch as the ending leaves it.
  const ending = (id: string, kind: string, text: string, commits: number, state: string, tokens?: string) => {
    if (commits >= 0) p.branch(id, commits);
    p.log({ phase: "impl", id, last: "<promise>COMPLETE</promise>", ago: 3600 + Number(id) });
    outcomes[id] = outcome(kind, text);
    tickets[id] = { state, since: NOW - 3600, started: NOW - 3600 - 1500, tokens };
  };
  p.land("401");
  p.log({ phase: "impl", id: "401", last: "<promise>COMPLETE</promise>", ago: 3700 });
  tickets["401"] = { state: "merged", since: NOW - 3000, started: NOW - 3000 - 2700, tokens: "3.1M in / 42k out" };
  p.land("402", true);
  p.log({ phase: "impl", id: "402", last: "<promise>COMPLETE</promise>", ago: 3800 });
  tickets["402"] = { state: "merged", since: NOW - 3000, started: NOW - 3000 - 600, unmet: "needs a decision from the maintainer", tokens: "1.2M in / 9.5k out" };
  ending("403", "green", "gated green, not landed (dry run)", 1, "ready");
  ending("404", "conflict", "conflicts in src/a.ts with #403", 1, "conflict");
  ending("405", "red", "red at landing: test_cart", 1, "red");
  ending("406", "held", "human merge: .github/", 1, "held");
  ending("407", "taken back", "marked for a person", 0, "held");
  ending("408", "uncommitted", "uncommitted files left in the sandbox", 1, "uncommitted");
  ending("409", "crashed", "agent exited with code 1", 1, "crashed");
  ending("410", "not landed", "landing gate failed twice", 1, "not landed");
  ending("411", "withdrawn", "closed while the run was going", 0, "withdrawn");
  ending("412", "stopped", "stopped before the review", 1, "stopped");
  ending("413", "no change", "nothing to change", 0, "nochange");
  // A leftover of an earlier run, a branch with no commits and no outcome, a log whose branch is gone, one labelled again.
  p.branch("414", 2);
  p.log({ phase: "impl", id: "414", last: "Edit(src/old.ts)", ago: 4 * 86400 });
  outcomes["414"] = { run: earlier, kind: "red", text: "red at landing" };
  p.branch("415", 0);
  p.log({ phase: "impl", id: "415", last: "Read(README.md)", ago: 5 * 86400 });
  p.log({ phase: "impl", id: "416", last: "Read(README.md)", ago: 6 * 86400 });
  p.branch("417", 1);
  p.log({ phase: "impl", id: "417", last: "Edit(src/c.ts)", ago: 7 * 86400 });
  p.json("run.json", {
    orchestrator: NAME,
    pid: 2 ** 22 + 4321,
    startedAt: started,
    finishedAt: iso(NOW - 600),
    exitCode: 0,
    models: "implement sonnet-5-5/high, review opus-5-5/high",
    issues: Object.keys(tickets),
    versions: { kit: "0.14.0" },
    tokens: "52M in / 810k out",
    settings: { ...SETTINGS, turn: 2 },
    tickets,
  });
  p.json("outcomes.json", outcomes);
  writeQueue(fixture, [{ id: "417" }, { id: "418" }, { id: "419", blockedOn: ["#418"] }]);
  fixture.tickets = { merged: "401", "merged (partly done)": "402", ready: "403", conflict: "404", red: "405", held: "406", "left over": "414" };
};

/** Builds one of the fixtures in `dir` (which the caller owns) and returns it. */
export const buildFixture = (kind: FixtureKind, dir: string): Fixture => {
  const root = join(dir, "my repo");
  const bin = join(dir, "bin");
  const cache = join(dir, "cache");
  for (const d of [root, bin, cache]) mkdirSync(d, { recursive: true });
  writeFakes(bin);
  const p = project(root);
  const run = kind === "ended" ? undefined : kitLikeProcess();
  const stop = () => {
    run?.kill();
    // A fake still blocked (`hang`) is no one's child once its view is gone, and ignores a hangup.
    for (const line of readFileSync(fixture.pids, "utf8").split("\n").filter(Boolean)) {
      try {
        process.kill(Number(line.split(" ")[0]), "SIGKILL");
      } catch {
        // already gone
      }
    }
  };
  const fixture: Fixture = { kind, root, bin, cache, pids: join(dir, "fake-pids"), mark: 0, hang: join(dir, "hang.fifo"), tickets: {}, containers: [], hot: "", stop: () => stop() };
  writeFileSync(fixture.pids, "");
  execFileSync("mkfifo", [fixture.hang]);
  if (kind === "live") live(fixture, p, run!);
  else if (kind === "legacy") legacy(fixture, p, run!);
  else ended(fixture, p);
  return fixture;
};

/** What a view needs in its environment to draw the fixture: the clock, the zone, the fakes first on `PATH`. */
export const fixtureEnv = (fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: [fixture.bin, process.env.PATH ?? ""].join(delimiter),
  TZ,
  SANDCASTLE_TEST_NOW: String(NOW),
  SANDCASTLE_PROJECT: fixture.root,
  SANDCASTLE_BIN: join(fixture.bin, "sandcastle"),
  SANDCASTLE_BASE: BASE,
  SANDCASTLE_NAME: NAME,
  XDG_CACHE_HOME: fixture.cache,
  FAKE_QUEUE_FILE: queueFile(fixture),
  FAKE_PIDS: fixture.pids,
  FAKE_HANG_FIFO: fixture.hang,
  ...(fixture.containers.length ? { FAKE_DOCKER: fixture.root, FAKE_DOCKER_TICKETS: fixture.containers.join(" "), FAKE_DOCKER_HOT: fixture.hot } : {}),
  ...extra,
});
