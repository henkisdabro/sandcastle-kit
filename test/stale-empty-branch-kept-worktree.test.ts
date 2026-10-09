// A ticket branch an earlier run left with no commit ahead of the base is cut from the base's tip again before
// its sandbox opens (test/stale-empty-branch.test.ts). A run killed before its sandboxes closed (Ctrl-C, a
// crash) leaves each ticket's worktree in `.sandcastle/worktrees/` with the branch checked out, and git refuses
// to move a branch a worktree holds: Sandcastle then reuses the worktree as it stands, so the agent started on
// the old tree. A clean kept worktree holds nothing to lose, so the branch and the worktree's checkout are moved
// together; one with an uncommitted or untracked file, or a person's own outside `.sandcastle/worktrees/`
// (test/stale-empty-branch.test.ts), is left as it is.
//
// The pipeline (`createPipeline`, src/burndown.ts) runs over its faked ports - a temp repo, the kept worktree
// as its sandbox (reused as Sandcastle does), scripted agents and gate runs, and the run's real host git
// (`createHostGit`) with its `.git` check. No Docker, model, gh or network.
//
//   pnpm test:file test/stale-empty-branch-kept-worktree.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merges pass process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { createHostGit } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-stale-empty-kept-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
};
const commit = (cwd: string, file: string, text: string, message = `change ${file}`) => {
  write(cwd, file, text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

const ID = "7";
const BRANCH = `agent/issue-${ID}`;
const issue = { id: ID, title: `ticket ${ID}`, body: "" } as Issue;
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const LANDED = ["a.txt", "b.txt", "c.txt"];

/**
 * A project in a temp repo whose `main` has three commits (and a tracked `local.env`, with `ignored`) more than the point ticket 7's branch was cut at, and
 * the worktree an earlier run left at `.sandcastle/worktrees/agent-issue-7` on that branch (0 ahead, 3 behind).
 * `dirty` leaves a file in it. `viaLink` gives the project its root as a symlink to the repo, as a project under
 * macOS's `/tmp` is (git records the real path of a worktree). `opened` is what the sandbox saw as it opened: the
 * branch's tip and the files the worktree held.
 */
const harness = (o: { dirty?: "untracked" | "modified"; viaLink?: boolean; ignored?: boolean } = {}) => {
  const real = join(TMP, `repo${n++}`);
  mkdirSync(real);
  git(real, "init", "-q", "-b", "main");
  git(real, "config", "user.name", "Operator Example");
  git(real, "config", "user.email", "operator@example.com");
  git(real, "config", "commit.gpgsign", "false");
  commit(real, "start.txt", "start\n", "start");
  if (o.ignored) commit(real, ".gitignore", "local.env\n", "ignore local.env");
  git(real, "branch", BRANCH, "main");
  for (const f of LANDED) commit(real, f, `${f}\n`, `landed ${f}`);
  // The base starts tracking a path the worktree will hold as an ignored file.
  if (o.ignored) {
    write(real, "local.env", "from the base\n");
    git(real, "add", "-f", "local.env");
    git(real, "commit", "-q", "-m", "track local.env");
  }
  const oldTip = git(real, "rev-parse", BRANCH);
  const mainTip = git(real, "rev-parse", "main");

  let root = real;
  if (o.viaLink) {
    root = join(TMP, `link${n++}`);
    symlinkSync(real, root);
  }
  // Where a run killed before its sandbox closed leaves it.
  const kept = join(real, ".sandcastle", "worktrees", "agent-issue-7");
  git(real, "worktree", "add", "-q", kept, BRANCH);
  if (o.dirty === "untracked") write(kept, "wip.txt", "unsaved\n");
  if (o.dirty === "modified") write(kept, "start.txt", "start, edited\n");
  if (o.ignored) write(kept, "local.env", "mine, kept out of git\n");

  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((name) => {
      const file = join(real, `.sandcastle/.run/${name}.md`);
      write(real, `.sandcastle/.run/${name}.md`, "{{ISSUE_NUMBER}} {{REVIEW_BASE}} {{REPAIR_BASE}}\n");
      return [name, file];
    }),
  ) as Ctx["prompts"];
  const events: string[] = [];
  const opened: { tip?: string; files: string[]; edited: boolean; localEnv?: string }[] = [];

  const open = async (branch: string): Promise<Box> => {
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: real }).status === 0;
    // As Sandcastle does: a worktree already on the branch is reused as it stands, the branch otherwise checked out.
    const listed = git(real, "worktree", "list", "--porcelain").split("\n\n").find((e) => e.split("\n").includes(`branch refs/heads/${branch}`));
    const reused = listed?.split("\n")[0].slice("worktree ".length);
    const path = reused ?? join(TMP, `wt${n++}`);
    if (!reused) {
      if (exists) git(real, "worktree", "add", "-q", path, branch);
      else git(real, "worktree", "add", "-q", "-b", branch, path, "main");
    }
    opened.push({
      tip: exists ? git(real, "rev-parse", `refs/heads/${branch}`) : undefined,
      files: [...LANDED, "wip.txt"].filter((f) => existsSync(join(path, f))),
      localEnv: existsSync(join(path, "local.env")) ? readFileSync(join(path, "local.env"), "utf8") : undefined,
      edited: existsSync(join(path, "start.txt")) && git(path, "status", "--porcelain", "--", "start.txt") !== "",
    });
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const name = (opts.name ?? "").split("-")[0];
        events.push(name);
        const before = git(path, "rev-parse", "HEAD");
        if (name === "impl") commit(path, "seven.txt", "seven\n");
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        git(real, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };

  const project = {
    root,
    name: "fixture",
    baseBranch: "main",
    gates: [{ name: "test", command: "run-tests" }],
    generated: [],
    setup: [],
    implement: {},
    review: {},
    repair: {},
  } as unknown as Ctx["project"];
  // Taken at the run's start, with the branch where the earlier run left it.
  const host = createHostGit(project, gitFingerprint(project));

  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-08T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      events.push("gate");
      return GREEN;
    },
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
    tampered: new Map(),
  });

  const attempt = async () => {
    const { result, lines } = await quietly(() => pipeline(issue));
    return { o: result, lines };
  };
  return { real, kept, oldTip, mainTip, opened, events, host, attempt };
};

const behind = `#7: ${BRANCH} had no commits ahead of main and was 3 commit(s) behind it`;
const behindIgnored = `#7: ${BRANCH} had no commits ahead of main and was 4 commit(s) behind it`;

test("a clean worktree a killed run left is moved to the base's tip with its branch, before the sandbox opens", async () => {
  const h = harness();
  const { o, lines } = await h.attempt();
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].tip, h.mainTip, "the branch is at the base's tip when the sandbox opens");
  assert.deepEqual(h.opened[0].files, LANDED, "the reused worktree holds the three landings it was behind");
  assert.ok(lines.includes(`${behind} - cut again from main's tip in its kept worktree.`), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("could not be cut again")), lines.join("\n"));
  // The agent's work sits on the base's tip, so nothing of the earlier run's fork point is left in it.
  assert.equal(o.status, "green");
  assert.equal(o.commits, 1);
  assert.equal(git(h.real, "rev-parse", `${BRANCH}~1`), h.mainTip);
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
});

test("the run's .git check passes after a kept worktree was moved: the run cut it, nothing else touched it", async () => {
  const h = harness();
  await h.attempt();
  await h.host.check("after the ticket");
  assert.equal(h.host.expected.branches[BRANCH], git(h.real, "rev-parse", BRANCH));
  assert.equal(h.host.failed, undefined);
});

test("a kept worktree is found when the project's root is a symlink and git lists the real path", async () => {
  const h = harness({ viaLink: true });
  assert.ok(realpathSync(h.kept).startsWith(realpathSync(h.real)));
  const { lines } = await h.attempt();
  assert.equal(h.opened[0].tip, h.mainTip);
  assert.ok(lines.includes(`${behind} - cut again from main's tip in its kept worktree.`), lines.join("\n"));
});

test("a worktree with an untracked file is left as it is: neither the branch nor the worktree moves", async () => {
  const h = harness({ dirty: "untracked" });
  const { o, lines } = await h.attempt();
  assert.equal(h.opened[0].tip, h.oldTip, "git refuses to move a branch a worktree holds, and the run does not force it");
  assert.deepEqual(h.opened[0].files, ["wip.txt"], "the worktree still lacks the landings, and the file is still there");
  assert.ok(lines.some((l) => l.startsWith(`${behind}, but could not be cut again from main's tip (`)), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("in its kept worktree.")), lines.join("\n"));
  assert.equal(o.status, "green");
});

test("a worktree with an edited tracked file is left as it is, and the edit is still there", async () => {
  const h = harness({ dirty: "modified" });
  const { lines } = await h.attempt();
  assert.equal(h.opened[0].tip, h.oldTip);
  assert.deepEqual(h.opened[0].files, []);
  assert.ok(h.opened[0].edited, "the uncommitted edit survived");
  assert.ok(lines.some((l) => l.startsWith(`${behind}, but could not be cut again from main's tip (`)), lines.join("\n"));
});

test("an ignored file in a kept worktree that the base now tracks survives: the worktree is not cut again, and the line says so", async () => {
  const h = harness({ ignored: true });
  assert.equal(git(h.kept, "status", "--porcelain"), "", "the kit's clean check does not see the ignored file");
  const { lines } = await h.attempt();
  assert.equal(h.opened[0].tip, h.oldTip, "the branch stays where it was");
  assert.equal(h.opened[0].localEnv, "mine, kept out of git\n", "the ignored file was not overwritten");
  assert.ok(lines.some((l) => l.startsWith(`${behindIgnored}, but could not be cut again from main's tip (`)), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("in its kept worktree.")), lines.join("\n"));
});
