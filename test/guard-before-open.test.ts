// The run's `.git` check before every sandbox opens. Sandcastle's open runs host git in the project: `git worktree add`,
// whose checkout writes every file out through the filters `.git/config` names, or `git status`, `git fetch` and
// `git merge` in a worktree it reuses. The kit's pins hold only the filters configured at the start (set here as a run
// sets them), so a smudge filter and the attribute that applies it, planted in the shared `.git` by another sandbox
// since the last check, would run on the host as the next sandbox opens. Each site is driven past such a plant: a
// ticket's pipeline (`createPipeline`) at its first open and at the resume after a pause, the gate sandboxes (`gateBase`
// with Sandcastle's own open over a fake `docker`: the mid-run base check, the verify, the base gates at a run's start
// and `sandcastle gates`), a run's landing sandbox (`landInSandbox`) and `sandcastle land` (`landTicket`). The open
// never happens, the filter never runs, and the stop is the run's. Temp repos and a fake `docker` on PATH: no Docker,
// model or network.
//
//   pnpm test:file test/guard-before-open.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

// Before the kit's modules load: sandbox.ts, pool.ts and peaks.ts derive their directories from these at import.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-guard-before-open-")));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
process.env.XDG_CONFIG_HOME = join(TMP, "config");
mkdirSync(join(TMP, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(TMP, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];

// A docker for Sandcastle's open and close of a gate sandbox. Every call is a line of `calls`, so a test can tell
// whether a container was ever started (`run`). `run` keeps the container's name and its mounts' host paths, which
// `ps` and `inspect` then give, as the kit's stop of a container before its close asks; a stop or a removal ends it.
// `exec` answers the gate sandbox's `git rev-parse HEAD`; everything else succeeds and says nothing.
const DOCKER = join(TMP, "docker");
mkdirSync(join(DOCKER, "bin"), { recursive: true });
writeFileSync(
  join(DOCKER, "bin", "docker"),
  `#!/bin/sh
echo "$*" >> "$FAKE_DOCKER/calls"
case "$1" in
  run)
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) echo "$2" > "$FAKE_DOCKER/name" ;;
        -v) echo "$2" | cut -d: -f1 >> "$FAKE_DOCKER/mounts" ;;
      esac
      shift
    done
    : > "$FAKE_DOCKER/running" ;;
  ps)
    case "$2" in
      -aq) cat "$FAKE_DOCKER/name" 2>/dev/null ;;
      -q) [ -e "$FAKE_DOCKER/running" ] && cat "$FAKE_DOCKER/name" 2>/dev/null ;;
    esac ;;
  inspect) [ "$2" = "$(cat "$FAKE_DOCKER/name" 2>/dev/null)" ] && cat "$FAKE_DOCKER/mounts" ;;
  stop|rm) rm -f "$FAKE_DOCKER/running" ;;
  exec)
    case "$*" in
      *"git rev-parse HEAD"*) git -C "$FAKE_DOCKER_REPO" rev-parse main ;;
    esac ;;
esac
exit 0
`,
);
chmodSync(join(DOCKER, "bin", "docker"), 0o755);
process.env.PATH = [join(DOCKER, "bin"), dirname(process.execPath), process.env.PATH].join(delimiter);
process.env.FAKE_DOCKER = DOCKER;

const { attempted, createPipeline } = await import("../src/burndown.ts");
const { createHostGit } = await import("../src/landing.ts");
const { assertGitUnchanged, disableHostGitHooks, gitFingerprint, pinHostGitConfig } = await import("../src/guard.ts");
const { landInSandbox, landTicket } = await import("../src/land.ts");
const { gateBase, requireGreenBase, verifyBase } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;
type Tracker = import("../src/tracker.ts").Tracker;

let n = 0;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string, message = `change ${file}`) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

/** A repo whose `main` holds `tracked.txt`, with `.sandcastle/` ignored as `sandcastle init` leaves it. */
const makeRepo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
  commit(root, "tracked.txt", "tracked\n", "start");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "ignore .sandcastle/");
  return root;
};

// The run's own host git environment: hooks off and the command-running keys pinned, as `burndown()` sets them.
disableHostGitHooks();
pinHostGitConfig(makeRepo());

/** What the filter a sandbox plants touches when a host git runs it. */
const MARKER = join(DOCKER, "filter-ran");
const filterRan = () => existsSync(MARKER);
/** What another sandbox, still running against the shared `.git`, can plant: a smudge filter and the attribute that applies it to every file. */
const plantFilter = (root: string) => {
  git(root, "config", "filter.evil.smudge", `touch ${MARKER}; cat`);
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  appendFileSync(join(root, ".git", "info", "attributes"), "* filter=evil\n");
};
/** The stop the plant makes, in the `.git` check's words, `when` it was made. */
const stopped = (when: string) =>
  new RegExp(`^Error: STOPPED ${when}: \\.git/config, \\.git/info/attributes changed while sandboxes ran\\. .*In \\.git/config: filter\\.evil\\.smudge added\\.`, "s");

/** A test's start: no filter has run, and `docker` was asked nothing and runs nothing. */
const fresh = (root: string) => {
  for (const f of ["calls", "name", "mounts"]) writeFileSync(join(DOCKER, f), "");
  for (const f of [MARKER, join(DOCKER, "running")]) rmSync(f, { force: true });
  process.env.FAKE_DOCKER_REPO = root;
};
/** Whether a container was ever started since the test's start. */
const containerStarted = () => readFileSync(join(DOCKER, "calls"), "utf8").split("\n").some((c) => c.startsWith("run "));
/** A running container the fake `docker` lists as mounting `path`, for a sandbox that never ran `docker run`. */
const containerOf = (path: string) => {
  writeFileSync(join(DOCKER, "name"), "sandcastle-made-up\n");
  writeFileSync(join(DOCKER, "mounts"), `${path}\n`);
  writeFileSync(join(DOCKER, "running"), "");
};
/** The worktrees git lists for `root`: the main one alone when no sandbox opened, or every one that opened has gone. */
const worktrees = (root: string) => git(root, "worktree", "list", "--porcelain").split("\n\n").length;

/**
 * Sandcastle's open as far as the host goes: the prune of worktree records, then `git worktree add` (a checkout, through
 * the smudge filters), or `git status` in a worktree already there.
 */
const sandcastleOpen = (root: string, branch: string) => {
  const path = join(root, ".sandcastle", "worktrees", branch.replace(/\//g, "-"));
  git(root, "worktree", "prune");
  if (existsSync(path)) spawnSync("git", ["status", "--porcelain"], { cwd: path });
  else if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0) git(root, "worktree", "add", "-q", path, branch);
  else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  return path;
};
/** The plant is one a host checkout runs, so the open the check refused would have run it. Last in a test: it adds a worktree. */
const plantWouldRun = (root: string) => {
  sandcastleOpen(root, `probe-${n++}`);
  assert.equal(filterRan(), true, "the planted filter does not run on a checkout: the test proves nothing");
};
/** Sandcastle's close as far as the host goes: its container stopped and removed, `git status` in the worktree, then the worktree removed if clean. */
const sandcastleClose = (root: string, path: string) => {
  const name = readFileSync(join(DOCKER, "name"), "utf8").trim();
  for (const args of [["stop", name], ["rm", name]]) spawnSync("docker", args);
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" }).stdout.trim() !== "";
  if (!dirty) git(root, "worktree", "remove", "--force", path);
  return { preservedWorktreePath: dirty ? path : undefined };
};
const execIn = (path: string) => async (cmd: string) => {
  const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};

const ID = "7";
const BRANCH = `agent/issue-${ID}`;
const WT = "agent-issue-7";
const issue = { id: ID, title: `ticket ${ID}`, body: "" } as Issue;
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/**
 * Ticket 7's pipeline over a temp repo behind the run's own host git (`createHostGit`), its sandbox opened and closed
 * as Sandcastle's is on the host (above). `afterCut` is what another sandbox writes the moment the setup's cut of a
 * stale branch is done (it goes through the host's one writer, which checks `.git` first). `whileParked` is what
 * another sandbox writes while a person's pause, taken as the implementer finishes, holds the ticket with its sandbox
 * closed.
 */
const harness = (o: { afterCut?: (root: string) => void; whileParked?: (root: string) => void } = {}) => {
  const root = makeRepo();
  fresh(root);
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((name) => {
      const file = join(root, `.sandcastle/.run/${name}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{{ISSUE_NUMBER}} {{REVIEW_BASE}} {{REPAIR_BASE}}\n");
      return [name, file];
    }),
  ) as Ctx["prompts"];
  const opened: string[] = [];
  const open = async (branch: string): Promise<Box> => {
    const path = sandcastleOpen(root, branch);
    containerOf(path);
    opened.push(path);
    return {
      worktreePath: path,
      exec: execIn(path),
      run: async (opts: { name?: string }) => {
        const before = git(path, "rev-parse", "HEAD");
        if ((opts.name ?? "").startsWith("impl")) commit(path, "seven.txt", "seven\n");
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => sandcastleClose(root, path),
    } as unknown as Box;
  };
  const project = { root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }], generated: [], setup: [], implement: {}, review: {}, repair: {} } as unknown as Project;
  const host = createHostGit(project, gitFingerprint(project));
  if (o.afterCut) {
    const { write } = host;
    host.write = (fn, made) => write(fn, made).finally(() => o.afterCut!(root));
  }
  const tampered = new Map<string, unknown>();
  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-09T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => GREEN,
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, _phase, fn) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host,
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered,
  });
  const at = o.whileParked
    ? {
        juncture: async (phase: string, park?: { suspend(): Promise<void>; resume(): Promise<void> }) => {
          if (phase !== "review" || !park) return;
          await park.suspend();
          o.whileParked!(root);
          await park.resume();
        },
      }
    : undefined;
  const attempt = () => quietly(() => pipeline(issue, at));
  return { root, wt: join(root, ".sandcastle", "worktrees", WT), tampered, opened, attempt };
};

/** The ticket's attempt, as the scheduler reads it: a crash whose cause, the failed check, stops the run. */
const stopsTheRun = (error: unknown) =>
  assert.deepEqual(attempted(ID, { status: "rejected", reason: error }, { error }), { kind: "crashed", error, causes: [{ kind: "tampered", error }] });

test("a filter planted in the shared .git while a ticket is paused stops the run before its sandbox opens again: the filter never runs", async () => {
  const h = harness({ whileParked: plantFilter });
  await assert.rejects(h.attempt(), stopped(`before reopening #7's sandbox after the pause`));
  assert.deepEqual(h.opened, [h.wt], "the resume opened a second sandbox");
  assert.equal(filterRan(), false, "the planted filter ran on the host as the sandbox opened");
  assert.equal(existsSync(h.wt), false, "a worktree was added for the second open");
  // The implementer's commit stays on the branch for the next run.
  assert.equal(git(h.root, "log", "-1", "--format=%s", BRANCH), "change seven.txt");
  const error = h.tampered.get(ID);
  assert.match(String(error), stopped(`before reopening #7's sandbox after the pause`));
  stopsTheRun(error);
  plantWouldRun(h.root);
});

test("a filter planted in the shared .git before a ticket's sandbox first opens stops the run, whether it comes before the setup's cut or after", async () => {
  // Before the setup, the cut's own `.git` check (the host's one writer) finds it; after the cut, the check before the open does.
  for (const c of [
    { plant: "before", when: "before writing to the base branch" },
    { plant: "after", when: "before opening #7's sandbox" },
  ]) {
    const h = harness(c.plant === "after" ? { afterCut: plantFilter } : {});
    if (c.plant === "before") plantFilter(h.root);
    await assert.rejects(h.attempt(), stopped(c.when), c.plant);
    assert.deepEqual(h.opened, [], `${c.plant} the cut: the sandbox opened`);
    assert.equal(filterRan(), false, `${c.plant} the cut: the planted filter ran on the host`);
    assert.equal(worktrees(h.root), 1, `${c.plant} the cut: a worktree was added`);
    const error = h.tampered.get(ID);
    assert.match(String(error), stopped(c.when), `${c.plant} the cut: the ticket's attempt does not stop the run`);
    stopsTheRun(error);
    plantWouldRun(h.root);
  }
});

test("a ticket's sandbox opens as before when nothing was planted: the check before the open is no false stop", async () => {
  const h = harness();
  const { result: o } = await h.attempt();
  assert.equal(o.status, "green");
  assert.deepEqual(h.opened, [h.wt]);
  assert.equal(h.tampered.size, 0, String(h.tampered.get(ID)));
});

/** A project for a gate sandbox, loaded as a run loads it, with the working directory at its root, where Sandcastle's open works. */
const gateSite = async (fn: (project: Project, plan: string, root: string) => Promise<void>) => {
  const root = makeRepo();
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "run-tests" }] };\n`);
  fresh(root);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    await fn(project, writePlan(project).file, root);
  } finally {
    process.chdir(cwd);
  }
  return root;
};
const IMAGE = "sandcastle-fixture:t";
/** No gate sandbox's worktree or branch was made, and the planted filter never ran. */
const nothingOpened = (root: string, what: string) => {
  assert.equal(containerStarted(), false, `${what}: a container was started`);
  assert.equal(filterRan(), false, `${what}: the planted filter ran on the host`);
  assert.equal(worktrees(root), 1, `${what}: a worktree was added`);
  assert.equal(git(root, "branch", "--list", "sandcastle/*"), "", `${what}: a gate branch was made`);
};

test("a gate sandbox opens behind the run's .git check: one planted since the last open never opens, and its filter never runs", async () => {
  let started = 0;
  const root = await gateSite(async (project, plan, root) => {
    const host = createHostGit(project, gitFingerprint(project));
    // The verify's sandbox opens and closes with nothing planted.
    const first = await quietly(() => gateBase(project, IMAGE, plan, "verify", false, "run-1", true, true, (when) => host.check(when)));
    assert.deepEqual(first.result.gates.map((g) => g.pass), [true]);
    started = readFileSync(join(DOCKER, "calls"), "utf8").split("\n").filter((c) => c.startsWith("run ")).length;
    // A ticket's sandbox, still running, plants a filter; a ticket red on a test then asks for the mid-run base check.
    plantFilter(root);
    await assert.rejects(
      quietly(() => gateBase(project, IMAGE, plan, "base-red", false, "run-1", false, true, (when) => host.check(when))),
      stopped("before opening the base-red sandbox"),
    );
  });
  assert.equal(started, 1, "the first gate sandbox never started");
  assert.equal(readFileSync(join(DOCKER, "calls"), "utf8").split("\n").filter((c) => c.startsWith("run ")).length, 1, "a second container was started");
  assert.equal(filterRan(), false, "the planted filter ran on the host");
  assert.equal(worktrees(root), 1, "a worktree was added for the second open");
  assert.equal(git(root, "branch", "--list", "sandcastle/base-red-*"), "");
  plantWouldRun(root);
});

test("every gate sandbox is checked before it opens: the mid-run base check, the verify, the base gates at a run's start and `sandcastle gates`", async () => {
  // The run's check (`HostGit.check`) for the first two; the run's reading at its start for the third, whose sandbox
  // closes behind a reading of its own; `sandcastle gates`' own fingerprint, before the open and the close, for the last.
  const sites: { what: string; label: string; gate: (p: Project, plan: string, reading: ReturnType<typeof gitFingerprint>) => Promise<unknown> }[] = [
    { what: "the mid-run base check", label: "base-red", gate: (p, plan, r) => gateBase(p, IMAGE, plan, "base-red", false, "run-1", false, true, (when) => createHostGit(p, r).check(when)) },
    { what: "the verify", label: "verify", gate: (p, plan, r) => verifyBase(p, IMAGE, plan, "run-1", (when) => createHostGit(p, r).check(when)) },
    { what: "the base gates at a run's start", label: "base-gates", gate: (p, plan, r) => requireGreenBase(p, IMAGE, plan, true, "run-1", undefined, (when) => assertGitUnchanged(p, r, when)) },
    { what: "`sandcastle gates`", label: "base-gates", gate: (p, plan, r) => requireGreenBase(p, IMAGE, plan, false, undefined, (when) => assertGitUnchanged(p, r, when)) },
  ];
  for (const s of sites) {
    const root = await gateSite(async (project, plan, root) => {
      const reading = gitFingerprint(project);
      plantFilter(root);
      await assert.rejects(quietly(() => s.gate(project, plan, reading)), stopped(`before opening the ${s.label} sandbox`), s.what);
    });
    nothingOpened(root, s.what);
  }
});

/** `agent/issue-1`, one commit ahead of a `main` that moved on since it forked: a landing is a real merge. */
const landingRepo = () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  commit(root, "a.txt", "a\n", "work on 1");
  git(root, "checkout", "-q", "main");
  commit(root, "other.txt", "moved on\n", "base moved");
  fresh(root);
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [{ name: "test", command: "true" }], setup: [] } as unknown as Project;
  const opened: string[] = [];
  const open = async (branch: string) => {
    const path = sandcastleOpen(root, branch);
    opened.push(path);
    return { worktreePath: path, exec: execIn(path), close: async () => sandcastleClose(root, path) };
  };
  return { root, project, opened, open, base: git(root, "rev-parse", "main"), head: git(root, "rev-parse", "agent/issue-1") };
};

test("a run's landing sandbox is checked against the run's fingerprint before it opens: one planted since never opens", async () => {
  const f = landingRepo();
  const host = createHostGit(f.project, gitFingerprint(f.project));
  plantFilter(f.root);
  await assert.rejects(
    landInSandbox(f.project, { branch: "agent/issue-1", head: f.head, message: "Merge agent/issue-1 (closes #1)" }, f.open, async () => GREEN, host.expected),
    stopped("before landing agent/issue-1 in a sandbox"),
  );
  assert.deepEqual(f.opened, [], "the landing sandbox opened");
  assert.equal(filterRan(), false, "the planted filter ran on the host");
  assert.equal(git(f.root, "rev-parse", "main"), f.base, "the base moved");
});

test("`sandcastle land` checks the shared .git against its own reading from its start before its sandbox opens: one planted during the image build never opens", async () => {
  const f = landingRepo();
  const tracker = { ref: (id: string) => `#${id}`, get: () => ({ open: true }) } as unknown as Tracker;
  // The image build, while something else writes the shared `.git`.
  const prepare = () => {
    plantFilter(f.root);
    return { open: f.open };
  };
  await assert.rejects(quietly(() => landTicket(f.project, tracker, "1", prepare)), stopped("before landing agent/issue-1 in a sandbox"));
  assert.deepEqual(f.opened, [], "the landing sandbox opened");
  assert.equal(filterRan(), false, "the planted filter ran on the host");
  assert.equal(git(f.root, "rev-parse", "main"), f.base, "the base moved");
  plantWouldRun(f.root);
});

test("`sandcastle land` lands as before when nothing was planted: the check before its open is no false stop", async () => {
  const f = landingRepo();
  const tracker = { ref: (id: string) => `#${id}`, get: () => ({ open: true }), close: () => {} } as unknown as Tracker;
  const { result: said } = await quietly(() => landTicket(f.project, tracker, "1", () => ({ open: f.open })));
  assert.match(said, /^Landed #1: merged agent\/issue-1 into main and closed it\./);
  assert.equal(git(f.root, "rev-parse", "main^2"), f.head);
  assert.equal(f.opened.length, 1);
});

// burndown() needs Docker; its wiring is held here instead.
test("a run's base gates open behind a check against the shared .git as the run started, read under its lock once a killed run's sandboxes are reaped", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  const body = src.indexOf("export const burndown = ");
  const reaped = src.indexOf("reapOrphans(project);", body);
  const reading = src.indexOf("const atStart = gitFingerprint(project);", body);
  const gates = src.indexOf("requireGreenBase(gateProject, image, planFile, true, runId, undefined, (when) => assertGitUnchanged(project, atStart, when))", body);
  assert.ok(src.indexOf("lockRun(project);", body) < reaped && reaped < reading, "the reading is taken before the lock is held, or before a killed run's sandboxes are stopped");
  assert.ok(reading < gates, "the base gates open with no check against the start's reading");
  // Every sandbox a ticket's pipeline opens goes through the check: `open` is called in one place.
  const pipeline = src.slice(src.indexOf("export const createPipeline = "), body);
  assert.deepEqual(pipeline.match(/\bopen\(branch\)/g), ["open(branch)"]);
  assert.match(pipeline, /await checkGit\(issue\.id, when\);\n\s*return open\(branch\);/);
});
