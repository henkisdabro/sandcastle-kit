// A conflict resolution that had to change a cleanly merged file: the resolver names each such file and why
// (`<stray path="...">reason</stray>`), and a named change goes on to the narrow review (which is shown the
// reason) and the gates, where an unnamed one is held for a person as before. The pipeline over a temp repo
// with scripted agents and gate runs; no Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-named-strays.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type GateRun = import("../src/gates.ts").GateRun;
type RedLanding = import("../src/landing.ts").RedLanding;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-pipeline-"));
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
const ISSUE = { id: ID, title: "seven", body: "" } as Parameters<ReturnType<typeof createPipeline>>[0];

const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/** What an agent does in the sandbox's worktree, by its pass: `impl`, `review`, `repair` or `resolve`. Returns its final message. */
type Agent = (worktree: string) => string | void;

/**
 * A project in a temp repo and a pipeline over it, with every port faked. `events` is each agent pass
 * and gate run in order; `passes` the passes' names and prompt arguments; `phases` each timed step.
 */
const harness = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n", "start");
  // Each prompt names every argument its pass may get, so `usedArgs` passes them all on.
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}} {{MERGE_STRAYS}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const events: string[] = [];
  const passes: { name: string; args: Record<string, string> }[] = [];
  const phases: string[] = [];
  const agents: Record<string, Agent> = {};
  const gates: GateRun[] = [];

  // Sandcastle's sandbox on the ticket's branch: a worktree of the shared repo, cut from main for a new branch.
  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const box = {
      worktreePath: path,
      // Git alone: what else the pipeline asks a sandbox (its memory peak) the fake does not have.
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string; promptArgs?: Record<string, string> }) => {
        const name = opts.name ?? "";
        const kind = name.split("-")[0];
        events.push(kind);
        passes.push({ name, args: opts.promptArgs ?? {} });
        const before = git(path, "rev-parse", "HEAD");
        const stdout = agents[kind]?.(path) ?? "";
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout, commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    };
    return box as unknown as Box;
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
    changelog: true,
  } as unknown as Ctx["project"];
  const results: PromiseSettledResult<Outcome>[] = [];
  const requeuedAs = new Map<string, string>();
  const reds = new Map<string, RedLanding>();
  const notes: Ctx["notes"] = [];

  /** A pipeline as burndown() makes one: each call is one attempt of the ticket. */
  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-04T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      events.push("gate");
      const next = gates.shift();
      assert.ok(next, "a gate run the test did not expect");
      return next;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, phase, fn) => {
      phases.push(phase);
      return fn();
    },
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs,
    results,
    reds,
    reports: new Map(),
    notes,
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });

  /** One attempt; its result is kept as burndown's attempt keeps it, and the events and phases start afresh. */
  const attempt = async () => {
    events.length = 0;
    passes.length = 0;
    phases.length = 0;
    const { result: o } = await quietly(() => pipeline(ISSUE));
    results.splice(0, results.length, ...results.filter((r) => r.status !== "fulfilled" || r.value.issue !== ID), { status: "fulfilled", value: o });
    return o;
  };
  /** The landing sent the ticket back once: its second attempt is to come. */
  const requeue = () => requeuedAs.set(ID, "requeued: conflicted with #1 at landing");
  /** Another ticket lands on main, changing `file`. */
  const land = (file: string, text: string) => commit(root, file, text, `Merge agent/issue-1 (closes #1)`);
  const tip = (ref: string) => git(root, "rev-parse", ref);
  /** A person commits `file` to the ticket's branch between runs. */
  const onBranch = (file: string, text: string) => {
    const path = join(TMP, `wt${n++}`);
    git(root, "worktree", "add", "-q", path, BRANCH);
    commit(path, file, text);
    git(root, "worktree", "remove", "--force", path);
  };
  return { root, agents, gates, events, passes, phases, notes, reds, attempt, requeue, land, tip, onBranch };
};

/** An implementer that commits `file`, saying `say`. */
const implementing = (file: string, text = `${file}\n`, say = ""): Agent => (wt) => {
  commit(wt, file, text);
  return say;
};

/** A first attempt whose implementer and reviewer each commit; then a landed ticket that conflicts with it in shared.txt. */
const conflicted = async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.agents.review = implementing("review.txt", "a reviewer's fix\n");
  h.gates.push(GREEN);
  const first = await h.attempt();
  assert.equal(first.reviewCommits, 1);
  h.land("shared.txt", "one\n");
  h.requeue();
  return h;
};


/** The resolution of `conflicted()`'s merge that also changes landed.txt, which the base added and the branch never had. */
const resolvingAlso = (say: string): Agent => (wt) => {
  write(wt, "shared.txt", "one\nseven\n");
  write(wt, "landed.txt", "another ticket's line, adapted\n");
  git(wt, "add", "shared.txt", "landed.txt");
  git(wt, "commit", "-q", "--no-edit");
  return say;
};

test("a cleanly merged file the resolver named goes to the narrow review, shown its reason, and to the gates", async () => {
  const h = await conflicted();
  h.land("landed.txt", "another ticket's line\n");
  h.agents.resolve = resolvingAlso('Done.\n<stray path="landed.txt">the landed assertion pinned the sentence this ticket replaces</stray>');
  h.agents.review = implementing("review-2.txt", "the resolution's review\n");
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["resolve", "review", "gate"]);
  assert.equal(o.status, "green");
  const shown = h.passes[1].args.MERGE_STRAYS;
  assert.match(shown, /`landed\.txt` - the landed assertion pinned the sentence this ticket replaces/);
  assert.deepEqual(h.notes, []);
});

test("a cleanly merged file the resolver did not name is held before any review or gate, and the note lists it", async () => {
  const h = await conflicted();
  h.land("landed.txt", "another ticket's line\n");
  h.land("other.txt", "a third line\n");
  h.agents.resolve = (wt) => {
    resolvingAlso("")(wt);
    write(wt, "other.txt", "changed too\n");
    git(wt, "add", "other.txt");
    git(wt, "commit", "-q", "--amend", "--no-edit");
    return '<stray path="landed.txt">adapted to the merge</stray>';
  };
  const o = await h.attempt();
  assert.deepEqual(h.events, ["resolve"]);
  assert.equal(o.status, "held");
  assert.match(o.heldNote ?? "", /^conflict resolution changed other\.txt, which merged cleanly/);
  assert.match(o.heldNote ?? "", /gave a reason for landed\.txt/);
});

test("a stray tag with no reason, or for another path, names nothing", async () => {
  const h = await conflicted();
  h.land("landed.txt", "another ticket's line\n");
  h.agents.resolve = resolvingAlso('<stray path="landed.txt"></stray>\n<stray path="elsewhere.txt">not the file</stray>');
  const o = await h.attempt();
  assert.deepEqual(h.events, ["resolve"]);
  assert.equal(o.status, "held");
  assert.match(o.heldNote ?? "", /changed landed\.txt,/);
});

test("a resolution that names a file it did not change reaches the review with nothing shown", async () => {
  const h = await conflicted();
  h.land("landed.txt", "another ticket's line\n");
  h.agents.resolve = (wt) => {
    write(wt, "shared.txt", "one\nseven\n");
    git(wt, "add", "shared.txt");
    git(wt, "commit", "-q", "--no-edit");
    return '<stray path="landed.txt">I changed it</stray>';
  };
  h.agents.review = implementing("review-2.txt", "r\n");
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(h.passes[1].args.MERGE_STRAYS, "");
});

test("a resolver's tag inside a fenced block or inline code is prose, not a claim", async () => {
  const h = await conflicted();
  h.land("landed.txt", "another ticket's line\n");
  h.agents.resolve = resolvingAlso("I would write `<stray path=\"landed.txt\">why</stray>` if asked.\n```\n<stray path=\"landed.txt\">why</stray>\n```");
  const o = await h.attempt();
  assert.equal(o.status, "held");
});
