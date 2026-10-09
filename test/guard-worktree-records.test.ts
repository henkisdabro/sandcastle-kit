// The `.git` check before a sandbox closes, and the worktree records it holds (src/guard.ts: `checkBeforeClose`,
// `assertWorktreeRecords`). Sandcastle's close stops the container, then runs `git status` on the host in the sandbox's
// worktree; its reuse of a kept worktree, and the pipeline's cut of a stale branch in one, run more host git there. A
// sandbox can write that worktree's records in the shared `.git` - the worktree's `.git` file, the record's
// `commondir`, a `config.worktree` - and a filter in the config a changed record names runs on the host, past the
// kit's pins (set here as a run sets them). Each site is driven with a sandbox whose close runs that `git status` as
// Sandcastle's does: a ticket's pipeline (`createPipeline`) at its end and at a pause, a kept worktree an earlier run
// left, a landing sandbox (`landInSandbox`), and a gate sandbox (`gateBase`, with Sandcastle's own close over a fake
// `docker`). A failed check removes the container with `docker rm -f` and never calls the close. The container is
// stopped before the check, so a process the sandbox left running there cannot write the shared `.git` between the
// check and that `git status`. Temp repos and a fake `docker` on PATH: no Docker, model or network.
//
//   pnpm test:file test/guard-worktree-records.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// Before the kit's modules load: sandbox.ts, pool.ts and peaks.ts derive their directories from these at import.
// Not removed after: test/in-temp.sh removes the temp directory, and Sandcastle's exit handler still calls this `docker`.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-worktree-records-")));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
process.env.XDG_CONFIG_HOME = join(TMP, "config");
mkdirSync(join(TMP, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(TMP, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];

// A docker for these tests. Every call is a line of `calls`. `run` keeps the container's name and its mounts' host
// paths, which `ps -aq` and `inspect` then give, as the kit's removal of a container asks, and marks it running, which
// `ps -q` then lists too; a test that opens no container writes the files itself. The container's processes are the
// pids in `procs`: a stop or a removal ends them, and a stopped container runs no `exec`. A gate command
// `plant-filter` does what a sandbox can: a filter in the shared `.git/config`, the attribute that applies it, and a
// tracked file whose stat no longer matches the index, so the next `git status` there reads it through the filter.
// `leave-writer` leaves a process running in the container that does the same once the kit unlocks the worktree
// (below). With `refuse-stop` there, a stop fails as Docker's can (AppArmor's "permission denied") and the container
// runs on. Everything else succeeds and says nothing.
const DOCKER = join(TMP, "docker");
mkdirSync(join(DOCKER, "bin"), { recursive: true });
writeFileSync(
  join(DOCKER, "bin", "docker"),
  `#!/bin/sh
echo "$*" >> "$FAKE_DOCKER/calls"
end() {
  for pid in $(cat "$FAKE_DOCKER/procs" 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
  : > "$FAKE_DOCKER/procs"
  rm -f "$FAKE_DOCKER/running"
}
unlocked() {
  for f in "$FAKE_DOCKER_REPO"/.git/worktrees/*/locked; do [ -e "$f" ] && return 1; done
  return 0
}
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
  stop)
    if [ -e "$FAKE_DOCKER/refuse-stop" ]; then
      echo "Error response from daemon: cannot stop container: permission denied" >&2
      exit 1
    fi
    # A process that watches the worktree's lock acts the moment the kit removes it, sooner than a stop's kill
    # lands: once the worktree is unlocked, the write it was waiting for is made before the container stops.
    if [ -s "$FAKE_DOCKER/procs" ] && unlocked; then
      i=0
      while [ ! -e "$FAKE_DOCKER/wrote" ] && [ $i -lt 250 ]; do sleep 0.02; i=$((i + 1)); done
    fi
    end ;;
  rm) end ;;
  exec)
    if [ ! -e "$FAKE_DOCKER/running" ]; then
      echo "Error response from daemon: container $(cat "$FAKE_DOCKER/name") is not running" >&2
      exit 1
    fi
    case "$*" in
      *"git rev-parse HEAD"*) git -C "$FAKE_DOCKER_REPO" rev-parse main ;;
      *plant-filter*)
        git -C "$FAKE_DOCKER_REPO" config filter.evil.clean "touch $FAKE_DOCKER/filter-ran"
        printf '* filter=evil\\n' >> "$FAKE_DOCKER_REPO/.git/info/attributes"
        for f in "$FAKE_DOCKER_REPO"/.sandcastle/worktrees/*/tracked.txt; do touch -t 200101010000 "$f"; done ;;
      *leave-writer*)
        sh "$FAKE_DOCKER/writer.sh" < /dev/null > /dev/null 2>&1 &
        echo $! >> "$FAKE_DOCKER/procs" ;;
    esac ;;
esac
exit 0
`,
);
chmodSync(join(DOCKER, "bin", "docker"), 0o755);
// The process `leave-writer` leaves running, as an agent's background job or a server a gate started would be. The
// container mounts the shared `.git`, so it can watch the sandbox's worktree lock, which the kit removes just before
// Sandcastle's close: the moment after the check. Then it plants what `plant-filter` does. Bounded, so a red test
// leaves nothing waiting.
writeFileSync(
  join(DOCKER, "writer.sh"),
  `i=0
while [ $i -lt 500 ]; do
  locked=
  for f in "$FAKE_DOCKER_REPO"/.git/worktrees/*/locked; do [ -e "$f" ] && locked=1; done
  if [ -z "$locked" ]; then
    git -C "$FAKE_DOCKER_REPO" config filter.evil.clean "touch $FAKE_DOCKER/filter-ran"
    printf '* filter=evil\\n' >> "$FAKE_DOCKER_REPO/.git/info/attributes"
    for f in "$FAKE_DOCKER_REPO"/.sandcastle/worktrees/*/tracked.txt; do touch -t 200101010000 "$f"; done
    : > "$FAKE_DOCKER/wrote"
    exit 0
  fi
  sleep 0.02
  i=$((i + 1))
done
`,
);
process.env.PATH = [join(DOCKER, "bin"), dirname(process.execPath), process.env.PATH].join(delimiter);
process.env.FAKE_DOCKER = DOCKER;

const { attempted, createPipeline } = await import("../src/burndown.ts");
const { createHostGit } = await import("../src/landing.ts");
const { disableHostGitHooks, gitFingerprint, pinHostGitConfig } = await import("../src/guard.ts");
const { landInSandbox } = await import("../src/land.ts");
const { gateBase } = await import("../src/gates.ts");
const { loadProject } = await import("../src/config.ts");
const { writePlan } = await import("../src/lean.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type Project = import("../src/config.ts").Project;
type GateRun = import("../src/gates.ts").GateRun;

// A sandbox Sandcastle never closed is named on stderr by Sandcastle's own exit handler ("Worktree preserved at"),
// which is the stop's case here: said to a person in a run, it is nothing for this file's output.
after(() => {
  console.error = () => {};
});

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
/** A test's start: no filter has run, `docker` was asked nothing and runs nothing, and its repo is the one a gate plants in. */
const fresh = (root: string) => {
  writeFileSync(join(DOCKER, "calls"), "");
  writeFileSync(join(DOCKER, "name"), "");
  writeFileSync(join(DOCKER, "mounts"), "");
  // A process an earlier test's container left running, if that test failed before a stop ended it.
  for (const pid of (existsSync(join(DOCKER, "procs")) ? readFileSync(join(DOCKER, "procs"), "utf8") : "").split("\n").filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      /* ended already */
    }
  }
  writeFileSync(join(DOCKER, "procs"), "");
  for (const f of [MARKER, join(DOCKER, "running"), join(DOCKER, "wrote"), join(DOCKER, "refuse-stop")]) rmSync(f, { force: true });
  process.env.FAKE_DOCKER_REPO = root;
};
const dockerCalls = () => readFileSync(join(DOCKER, "calls"), "utf8").split("\n").filter(Boolean);
/** A moment of the test's own (`check`, `close`), put among the `docker` calls in the order it came. */
const mark = (what: string) => appendFileSync(join(DOCKER, "calls"), `${what}\n`);
/** A running container the fake `docker` lists as mounting `path`, for a sandbox that never ran `docker run`. */
const containerOf = (path: string) => {
  writeFileSync(join(DOCKER, "name"), "sandcastle-made-up\n");
  writeFileSync(join(DOCKER, "mounts"), `${path}\n`);
  writeFileSync(join(DOCKER, "running"), "");
};
/** What the closing sandbox's container does: leaves a process running there (`leave-writer`, above). */
const leaveWriter = () => execFileSync("docker", ["exec", "sandcastle-made-up", "sh", "-c", "leave-writer"]);
/** Whether that process, or a gate, put its filter in the shared `.git/config`. */
const planted = (root: string) => spawnSync("git", ["config", "filter.evil.clean"], { cwd: root }).status === 0;
/**
 * The close of a sandbox from the kit's stop of its container on: the stops, removals, checks and closes, each as
 * its first word. The kit's stop is the first of the test: Sandcastle's close stops the container again, after it.
 */
const fromTheStop = () => {
  const calls = dockerCalls().map((c) => c.split(" ")[0]).filter((c) => ["stop", "kill", "rm", "check", "close"].includes(c));
  return calls.slice(calls.indexOf("stop"));
};

/** A tracked file whose stat no longer matches the index: the next `git status` reads it, through any clean filter. */
const staleStat = (wt: string) => utimesSync(join(wt, "tracked.txt"), new Date(2001, 0, 1), new Date(2001, 0, 1));
const recordOf = (root: string, wt: string) => join(root, ".git", "worktrees", basename(wt));

/** What a sandbox can do to its worktree's record: a common directory of its own, holding a filter, named by `commondir`. */
const plantCommonDir = (root: string, wt: string) => {
  const planted = join(wt, ".planted");
  for (const d of ["objects", "refs"]) cpSync(join(root, ".git", d), join(planted, d), { recursive: true });
  cpSync(join(root, ".git", "HEAD"), join(planted, "HEAD"));
  mkdirSync(join(planted, "info"), { recursive: true });
  writeFileSync(join(planted, "config"), `[core]\n\trepositoryformatversion = 0\n[filter "evil"]\n\tclean = touch ${MARKER}\n`);
  writeFileSync(join(planted, "info", "attributes"), "* filter=evil\n");
  writeFileSync(join(recordOf(root, wt), "commondir"), `${planted}\n`);
  staleStat(wt);
};

/** What a sandbox can do with the shared `.git` itself: a new filter in its config, and the attribute that applies it. */
const plantFilter = (root: string, wt: string) => {
  git(root, "config", "filter.evil.clean", `touch ${MARKER}`);
  writeFileSync(join(root, ".git", "info", "attributes"), "* filter=evil\n");
  staleStat(wt);
};

/**
 * Sandcastle's close, as far as the host goes: its container stopped and removed (`docker stop`, `docker rm`, a
 * failure ignored), then `git status` in the worktree, then the worktree removed if clean.
 */
const sandcastleClose = (root: string, path: string) => {
  mark("close");
  const name = readFileSync(join(DOCKER, "name"), "utf8").trim();
  for (const args of [["stop", name], ["rm", name]]) spawnSync("docker", args);
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" }).stdout.trim() !== "";
  if (!dirty) git(root, "worktree", "remove", "--force", path);
  return { preservedWorktreePath: dirty ? path : undefined };
};

const ID = "7";
const BRANCH = `agent/issue-${ID}`;
const WT = "agent-issue-7";
const issue = { id: ID, title: `ticket ${ID}`, body: "" } as Issue;
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/**
 * Ticket 7's pipeline over a temp repo, its sandbox a worktree at `.sandcastle/worktrees/agent-issue-7` as
 * Sandcastle's is. Opening it reuses a worktree already there and runs `git status` in it, as Sandcastle's open does;
 * closing it runs Sandcastle's close (above). `act` is what the sandbox does after the implementer's commit.
 * `earlier` sets the repo up before the run's fingerprint is taken: what an earlier run left.
 */
const harness = (o: { act?: (root: string, wt: string) => void; earlier?: (root: string) => void; pauseBeforeReview?: boolean } = {}) => {
  const root = makeRepo();
  const wt = join(root, ".sandcastle", "worktrees", WT);
  o.earlier?.(root);
  fresh(root);
  containerOf(wt);
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((name) => {
      const file = join(root, `.sandcastle/.run/${name}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "{{ISSUE_NUMBER}} {{REVIEW_BASE}} {{REPAIR_BASE}}\n");
      return [name, file];
    }),
  ) as Ctx["prompts"];
  const opened: string[] = [];
  const closed: string[] = [];
  const open = async (branch: string): Promise<Box> => {
    const path = join(root, ".sandcastle", "worktrees", branch.replace(/\//g, "-"));
    // Sandcastle's open prunes the records of worktrees whose directory is gone (a scratch repo: never the project's).
    git(root, "worktree", "prune");
    if (existsSync(path)) spawnSync("git", ["status", "--porcelain"], { cwd: path });
    else if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    // Its container runs, as a fresh one does.
    writeFileSync(join(DOCKER, "running"), "");
    opened.push(path);
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const before = git(path, "rev-parse", "HEAD");
        if ((opts.name ?? "").startsWith("impl")) {
          commit(path, "seven.txt", "seven\n");
          o.act?.(root, path);
        }
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        closed.push(path);
        return sandcastleClose(root, path);
      },
    } as unknown as Box;
  };
  const project = { root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }], generated: [], setup: [], implement: {}, review: {}, repair: {} } as unknown as Project;
  const host = createHostGit(project, gitFingerprint(project));
  // The checks before a close, at the pipeline's end and at a pause, put among the `docker` calls.
  const { check, settle } = host;
  host.check = (when) => (mark("check"), check(when));
  host.settle = (branch, when) => (mark("check"), settle(branch, when));
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
  // A person pauses the run as the implementer finishes: the sandbox closes before the review, and opens again after.
  const at = o.pauseBeforeReview
    ? {
        juncture: async (phase: string, park?: { suspend(): Promise<void>; resume(): Promise<void> }) => {
          if (phase !== "review" || !park) return;
          await park.suspend();
          await park.resume();
        },
      }
    : undefined;
  const attempt = () => quietly(() => pipeline(issue, at));
  return { root, wt, host, tampered, opened, closed, attempt };
};

/** Where the stop says not to run git: the worktree still stands, its container removed with `docker rm -f`, not closed. */
const leftForAPerson = (wt: string) => {
  assert.ok(existsSync(join(wt, ".git")), "the worktree was removed");
  assert.ok(dockerCalls().includes("rm -f sandcastle-made-up"), dockerCalls().join("\n"));
};

test("a sandbox that rewrites its worktree's commondir stops the run before its sandbox closes: no host git runs there", async () => {
  const h = harness({ act: plantCommonDir });
  const { result: o } = await h.attempt();
  assert.deepEqual(h.closed, [], "Sandcastle's close ran its host git status in the worktree");
  assert.equal(filterRan(), false, "the filter the sandbox planted ran on the host");
  const error = h.tampered.get(ID) as Error;
  assert.match(
    error.message,
    /^STOPPED after #7: the worktree record of agent-issue-7 is not the one git wrote: \.git\/worktrees\/agent-issue-7\/commondir no longer names the shared \.git \(git writes \.\.\/\.\.\)\. A sandbox may have tampered with it/,
  );
  leftForAPerson(h.wt);
  // The attempt reports the check, which stops the run: the green branch lands on a later run, not this one.
  assert.equal(o.status, "green");
  assert.deepEqual(attempted(ID, { status: "fulfilled", value: o }, { error }), { kind: "stopped", cause: { kind: "tampered", error } });
});

test("a filter a sandbox adds to the shared .git/config stops the run before its sandbox closes", async () => {
  const h = harness({ act: plantFilter });
  await h.attempt();
  assert.deepEqual(h.closed, []);
  assert.equal(filterRan(), false, "the filter the sandbox planted ran on the host");
  assert.match((h.tampered.get(ID) as Error).message, /^STOPPED after #7: \.git\/config, \.git\/info\/attributes changed while sandboxes ran\. .*In \.git\/config: filter\.evil\.clean added\./s);
  leftForAPerson(h.wt);
});

test("a worktree record changed during a pause stops the run before the pause closes its sandbox", async () => {
  const h = harness({ act: plantCommonDir, pauseBeforeReview: true });
  await assert.rejects(h.attempt(), /^Error: STOPPED before closing #7's sandbox for the pause: the worktree record of agent-issue-7 is not the one git wrote/);
  assert.deepEqual(h.closed, []);
  assert.equal(filterRan(), false);
  assert.match(String(h.tampered.get(ID)), /STOPPED before closing #7's sandbox for the pause/);
  assert.deepEqual(h.opened, [h.wt], "the resume opened another sandbox");
  leftForAPerson(h.wt);
});

test("a sandbox left as git made it closes as before, its .git file written with a relative path (git 2.48's worktree.useRelativePaths) too", async () => {
  // git before 2.48 writes an absolute path: the relative form, written here, is what `worktree.useRelativePaths` gives.
  const relativePointer = (root: string, wt: string) => writeFileSync(join(wt, ".git"), `gitdir: ${relative(wt, recordOf(root, wt))}\n`);
  for (const act of [undefined, relativePointer]) {
    const h = harness({ act });
    const { result: o } = await h.attempt();
    assert.equal(o.status, "green");
    assert.deepEqual(h.closed, [h.wt], act ? "relative paths" : "absolute paths");
    assert.equal(h.tampered.size, 0, String(h.tampered.get(ID)));
    // Removed by the close (`rm`), never without it (`rm -f`).
    assert.ok(!dockerCalls().some((c) => c.startsWith("rm -f")), dockerCalls().join("\n"));
    assert.equal(h.host.expected.branches[BRANCH], git(h.root, "rev-parse", BRANCH));
  }
});

/**
 * What an earlier run killed before its sandbox closed leaves: ticket 7's worktree at `.sandcastle/worktrees/`, its
 * branch checked out - three commits behind `main` with none ahead (`behind`), or one ahead - and its sandbox's change
 * to the record, which this run's fingerprint, taken at its start, reads as the way things are.
 */
const earlierRun = (o: { behind: boolean; tamper: (root: string, wt: string) => void }) => (root: string) => {
  git(root, "branch", BRANCH, "main");
  if (o.behind) for (const f of ["a.txt", "b.txt", "c.txt"]) commit(root, f, `${f}\n`);
  const wt = join(root, ".sandcastle", "worktrees", WT);
  git(root, "worktree", "add", "-q", wt, BRANCH);
  if (!o.behind) commit(wt, "earlier.txt", "earlier\n");
  o.tamper(root, wt);
};

/** A `config.worktree` with a filter, which git reads once the shared config turns `extensions.worktreeConfig` on. */
const worktreeConfig = (root: string, wt: string) => {
  git(root, "config", "core.repositoryformatversion", "1");
  git(root, "config", "extensions.worktreeConfig", "true");
  writeFileSync(join(root, ".git", "info", "attributes"), "* filter=evil\n");
  writeFileSync(join(recordOf(root, wt), "config.worktree"), `[filter "evil"]\n\tclean = touch ${MARKER}\n`);
  staleStat(wt);
};

test("a kept worktree whose record an earlier run changed is never moved: the run stops before the stale branch is cut there", async () => {
  const h = harness({ earlier: earlierRun({ behind: true, tamper: worktreeConfig }) });
  const tip = git(h.root, "rev-parse", BRANCH);
  await assert.rejects(
    h.attempt(),
    /^Error: STOPPED before moving agent\/issue-7 in \.sandcastle\/worktrees\/agent-issue-7: the worktree record of agent-issue-7 is not the one git wrote: \.git\/worktrees\/agent-issue-7\/config\.worktree exists/,
  );
  assert.equal(filterRan(), false, "the config.worktree filter ran on the host");
  assert.deepEqual(h.opened, [], "a sandbox opened on the worktree");
  assert.equal(git(h.root, "rev-parse", BRANCH), tip, "the branch was moved");
  assert.ok(h.tampered.has(ID));
});

test("a kept worktree whose record an earlier run changed is not reused: the run stops before its sandbox opens", async () => {
  const h = harness({ earlier: earlierRun({ behind: false, tamper: plantCommonDir }) });
  await assert.rejects(h.attempt(), /^Error: STOPPED before reusing \.sandcastle\/worktrees\/agent-issue-7: the worktree record of agent-issue-7 is not the one git wrote: .*commondir/);
  assert.equal(filterRan(), false, "the planted filter ran on the host as the sandbox opened");
  assert.deepEqual(h.opened, []);
  assert.ok(h.tampered.has(ID));
});

test("a kept worktree whose directory a person removed is no tampering: the run opens a fresh one, as Sandcastle's prune lets it", async () => {
  // git still lists the record, as prunable; no git can run in a directory that is gone.
  for (const behind of [false, true]) {
    const h = harness({ earlier: earlierRun({ behind, tamper: (_root, wt) => rmSync(wt, { recursive: true, force: true }) }) });
    const { result: o } = await h.attempt();
    assert.equal(h.tampered.size, 0, String(h.tampered.get(ID)));
    assert.equal(o.status, "green", behind ? "behind the base" : "ahead of the base");
    assert.deepEqual(h.opened, [h.wt]);
  }
});

test("a landing sandbox whose worktree's .git is repointed is never closed: the landing stops, the base where it was", async () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  commit(root, "a.txt", "a\n", "work on 1");
  git(root, "checkout", "-q", "main");
  commit(root, "other.txt", "moved on\n", "base moved");
  const base = git(root, "rev-parse", "main");
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  fresh(root);
  const closed: string[] = [];
  const open = async (branch: string) => {
    const path = join(root, ".sandcastle", "worktrees", branch.replace(/\//g, "-"));
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    containerOf(path);
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => {
        closed.push(path);
        return sandcastleClose(root, path);
      },
    };
  };
  // The landing gate runs the branch's code: it points the worktree at a git directory of its own.
  const gate = async (box: { worktreePath: string }) => {
    const planted = join(box.worktreePath, ".planted");
    git(TMP, "init", "-q", planted);
    writeFileSync(join(box.worktreePath, ".git"), `gitdir: ${join(planted, ".git")}\n`);
    return GREEN;
  };
  const head = git(root, "rev-parse", "agent/issue-1");
  await assert.rejects(
    landInSandbox(project, { branch: "agent/issue-1", head, message: "Merge agent/issue-1 (closes #1)" }, open, gate, gitFingerprint(project)),
    /^Error: STOPPED after landing agent\/issue-1 in a sandbox: the worktree record of sandcastle-land-agent-issue-1-\d+ is not the one git wrote: the worktree's \.git names ".*\.planted\/\.git", not \.git\/worktrees\/sandcastle-land-agent-issue-1-\d+\./,
  );
  assert.deepEqual(closed, [], "Sandcastle's close ran its host git status in the worktree");
  assert.ok(dockerCalls().includes("rm -f sandcastle-made-up"), dockerCalls().join("\n"));
  assert.equal(git(root, "rev-parse", "main"), base, "the base was fast-forwarded");
});

test("a gate sandbox that plants a filter in .git/config is never closed by Sandcastle: its container is removed, no host git status runs", async () => {
  const root = makeRepo();
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "plant-filter" }] };\n`);
  fresh(root);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    const plan = writePlan(project).file;
    // The base gates at a run's start, which have no run's check around them: the sandbox takes its own reading.
    await assert.rejects(
      quietly(() => gateBase(project, "sandcastle-fixture:t", plan, "base-gates", false, "run-1")),
      /^Error: STOPPED before closing the base-gates sandbox: \.git\/config, \.git\/info\/attributes changed while sandboxes ran\. .*In \.git\/config: filter\.evil\.clean added\./s,
    );
  } finally {
    process.chdir(cwd);
  }
  const name = readFileSync(join(DOCKER, "name"), "utf8").trim();
  assert.match(name, /^sandcastle-/, "no container was started");
  assert.ok(dockerCalls().includes(`rm -f ${name}`), dockerCalls().join("\n"));
  // Sandcastle's close stops the container (`docker stop`) before its host git status: it never began.
  assert.ok(!dockerCalls().includes(`stop ${name}`), dockerCalls().join("\n"));
  assert.equal(filterRan(), false, "the filter the gate planted ran on the host");
  assert.equal(git(root, "worktree", "list", "--porcelain").split("\n\n").length, 2, "the gate sandbox's worktree was removed");
});

// A process the closing sandbox left running in its container - `leave-writer`, which plants its filter the moment
// the kit unlocks the worktree, after the check - would write between the check and Sandcastle's host `git status`
// if the container still ran: the container is stopped first, then the check, then the close.

/** Nothing the process left running wrote: no filter in the shared `.git/config`, none run on the host. */
const nothingWritten = (root: string) => {
  assert.equal(existsSync(join(DOCKER, "wrote")), false, "the process the sandbox left running wrote after the check");
  assert.equal(planted(root), false, "a filter is in the shared .git/config");
  assert.equal(filterRan(), false, "the filter ran on the host");
};

test("a ticket's sandbox has its container stopped before the .git check at its pipeline's end, and before the one at a pause: nothing it left running writes after the check", async () => {
  for (const pauseBeforeReview of [false, true]) {
    const h = harness({ act: leaveWriter, pauseBeforeReview });
    const { result: o } = await h.attempt();
    assert.equal(h.tampered.size, 0, String(h.tampered.get(ID)));
    assert.equal(o.status, "green");
    nothingWritten(h.root);
    if (!pauseBeforeReview) {
      assert.deepEqual(h.closed, [h.wt]);
      assert.deepEqual(fromTheStop(), ["stop", "check", "close", "stop", "rm"], dockerCalls().join("\n"));
    } else {
      // The pause's close, then the close of the sandbox the resume opened.
      assert.deepEqual(h.closed, [h.wt, h.wt]);
      assert.deepEqual(fromTheStop(), ["stop", "check", "close", "stop", "rm", "stop", "check", "close", "stop", "rm"], dockerCalls().join("\n"));
    }
  }
});

test("a gate sandbox has its container stopped before the run's .git check, then Sandcastle closes it: nothing a gate left running writes after the check", async () => {
  const root = makeRepo();
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "leave-writer" }] };\n`);
  fresh(root);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const project = await loadProject(root);
    const host = createHostGit(project, gitFingerprint(project));
    // The verify's gate sandbox, closed behind the run's own check.
    const run = await quietly(() =>
      gateBase(project, "sandcastle-fixture:t", writePlan(project).file, "verify", false, "run-1", true, true, (when) => (mark("check"), host.check(when))),
    );
    assert.deepEqual(run.result.gates.map((g) => g.pass), [true]);
  } finally {
    process.chdir(cwd);
  }
  nothingWritten(root);
  assert.deepEqual(fromTheStop(), ["stop", "check", "stop", "rm"], dockerCalls().join("\n"));
  const calls = dockerCalls();
  assert.ok(!calls.slice(calls.findIndex((c) => c.startsWith("stop"))).some((c) => c.startsWith("exec")), "the sandbox ran a command after its container stopped");
  assert.equal(git(root, "worktree", "list", "--porcelain").split("\n\n").length, 1, "Sandcastle's close kept the gate sandbox's worktree");
});

test("a landing sandbox has its container stopped before the .git check, then it closes and lands: nothing its gate left running writes after the check", async () => {
  const root = makeRepo();
  git(root, "checkout", "-q", "-b", "agent/issue-1", "main");
  commit(root, "a.txt", "a\n", "work on 1");
  git(root, "checkout", "-q", "main");
  const project = { root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Project;
  fresh(root);
  const closed: string[] = [];
  // Locked as it opens and unlocked before Sandcastle's close, as `sandboxOpener`'s sandbox is.
  const open = async (branch: string) => {
    const path = join(root, ".sandcastle", "worktrees", branch.replace(/\//g, "-"));
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    git(root, "worktree", "lock", "--reason", "sandcastle: live sandbox", path);
    containerOf(path);
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      close: async () => {
        closed.push(path);
        git(root, "worktree", "unlock", path);
        return sandcastleClose(root, path);
      },
    };
  };
  // The landing gate runs the branch's code, which leaves a process running in the container.
  const gate = async () => {
    leaveWriter();
    return GREEN;
  };
  const head = git(root, "rev-parse", "agent/issue-1");
  const landed = await landInSandbox(project, { branch: "agent/issue-1", head, message: "Merge agent/issue-1 (closes #1)" }, open, gate, gitFingerprint(project));
  assert.equal(landed.kind, "merged");
  assert.equal(git(root, "rev-parse", "main^2"), head, "the base was not fast-forwarded to the landing merge");
  assert.equal(closed.length, 1);
  nothingWritten(root);
  // The landing's check is its own fingerprint's, between the stop and the close.
  assert.deepEqual(fromTheStop(), ["stop", "close", "stop", "rm"], dockerCalls().join("\n"));
});

test("a container Docker refuses to stop is never checked past: the run stops, the container is removed, and Sandcastle's close is never called", async () => {
  const h = harness();
  writeFileSync(join(DOCKER, "refuse-stop"), "");
  const { result: o } = await h.attempt();
  assert.deepEqual(h.closed, [], "Sandcastle's close ran its host git status in the worktree");
  const error = h.tampered.get(ID) as Error;
  assert.match(
    error.message,
    /^STOPPED after #7: the container of agent-issue-7 could not be stopped \(Error response from daemon: cannot stop container: permission denied\), so a process left running there could still write the shared \.git after the check\./,
  );
  assert.ok(!dockerCalls().includes("check"), "the .git check ran with the container still running");
  leftForAPerson(h.wt);
  assert.equal(o.status, "green");
  assert.deepEqual(attempted(ID, { status: "fulfilled", value: o }, { error }), { kind: "stopped", cause: { kind: "tampered", error } });
});

// burndown() needs Docker; its wiring is held here instead.
test("a run's mid-run base check and its verify close their gate sandboxes behind the run's own .git check, and `sandcastle gates` behind its own", () => {
  const burndown = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(burndown, /baseGate: \(\) => gateBase\(gateProject, image, planFile, "base-red", false, runId, false, true, \(when\) => host\.check\(when\)\)/);
  assert.match(burndown, /verifyBase\(gateProject, image, planFile, runId, \(when\) => host\.check\(when\)\)/);
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
  assert.match(cli, /requireGreenBase\(gateOnly\(project\), .*, \(when\) => assertGitUnchanged\(project, fingerprint, when\)\)/);
});
