// One ticket's pipeline (`createPipeline`, src/burndown.ts) driven through its ports: a temp repo, a
// host worktree for the sandbox whose `run` is a scripted agent that commits there, and scripted gate
// runs. No Docker, model, gh or network. The requeue's paths - the repair count kept across attempts,
// the gate run skipped on a base that has not moved, the land-only resolution and its review - and what
// a green head carries to a later run are held by what the pipeline does, not by its source text.
//
//   pnpm exec tsx --test test/pipeline.test.ts

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
const { readHeads } = await import("../src/run.ts");
const { ownCommits } = await import("../src/sandbox.ts");
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
const red = (output: string): GateRun => {
  const failure = { name: "test", command: "run-tests", exitCode: 1, output };
  return { gates: [{ name: "test", pass: false }], failure, failures: [failure] };
};

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
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}} {{GATE_NAME}} {{GATE_COMMAND}} {{GATE_OUTPUT}} {{REVIEW_BASE}} {{REPAIR_BASE}} {{IMPL_UNMET}}\n");
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

test("a ticket repaired once, requeued and repaired again reports both repairs", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt", "fix 1\n");
  h.gates.push(red("FAIL: first"), GREEN);
  const first = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate", "review"]);
  assert.equal(first.status, "green");
  assert.equal(first.repairs, 1);

  // A conflict at landing: another ticket landed, and the requeue merges it in and runs the branch's gates again.
  h.land("b.txt", "b\n");
  h.requeue();
  h.agents.repair = implementing("fix.txt", "fix 2\n");
  h.gates.push(red("FAIL: second"), GREEN);
  const second = await h.attempt();
  // Land only: reviewed and green at its head, so no implementer and no full review - the gates, a repair, its review.
  assert.deepEqual(h.events, ["gate", "repair", "gate", "review"]);
  assert.equal(second.status, "green");
  assert.equal(second.repairs, 2, "the first attempt's repair and the second's");
});

test("a branch never repaired before counts only this attempt's repairs", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(GREEN);
  assert.equal((await h.attempt()).repairs, 0);
  h.land("b.txt", "b\n");
  h.requeue();
  h.agents.repair = implementing("fix.txt");
  h.gates.push(red("FAIL: together"), GREEN);
  assert.equal((await h.attempt()).repairs, 1);
});

/** A green first attempt, then a red landing gate on the base tip it merged with: what the requeue reads. */
const redAtLanding = async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.gates.push(GREEN);
  assert.equal((await h.attempt()).status, "green");
  h.land("b.txt", "b\n");
  const landing = red("FAIL: a.txt and b.txt cannot both exist");
  h.reds.set(ID, { head: h.tip(BRANCH), base: h.tip("main"), failure: landing.failure!, gates: landing.gates });
  h.requeue();
  h.agents.repair = (wt) => {
    git(wt, "rm", "-q", "b.txt");
    git(wt, "commit", "-q", "-m", "keep a.txt alone");
  };
  return h;
};

test("a requeue on the base its landing gate went red on repairs from that gate's output, with no gate run first", async () => {
  const h = await redAtLanding();
  h.gates.push(GREEN);
  const o = await h.attempt();
  // The repair comes first: a gate run on the same tree would only return the same red.
  assert.deepEqual(h.events, ["repair", "gate", "review"]);
  const repair = h.passes.find((p) => p.name === `repair-${ID}`);
  assert.match(repair?.args.GATE_OUTPUT ?? "", /FAIL: a\.txt and b\.txt cannot both exist/);
  assert.equal(repair?.args.GATE_NAME, "test");
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 1);
  assert.equal(h.reds.has(ID), false, "the landing's red is read once");
});

test("a requeue on a base that moved since its landing gate went red runs the gates first", async () => {
  const h = await redAtLanding();
  // A third ticket lands after the red: the requeue's merge is no longer the tree the landing gate ran.
  h.land("c.txt", "c\n");
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
  assert.equal(o.status, "green");
  assert.equal(o.repairs, 0);
});

test("a requeue whose landing red was for another branch head runs the gates first", async () => {
  // The base has not moved, but a landing's red stands only for the branch head it merged: from
  // another head it says nothing of the tree this requeue made.
  const h = await redAtLanding();
  const kept = h.reds.get(ID)!;
  h.reds.set(ID, { ...kept, head: h.tip("main") });
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
});

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

test("a land-only requeue resolves the merge as its own phase and keeps the first attempt's review commits", async () => {
  const h = await conflicted();
  h.agents.resolve = (wt) => {
    write(wt, "shared.txt", "one\nseven\n");
    git(wt, "add", "shared.txt");
    git(wt, "commit", "-q", "--no-edit");
  };
  h.agents.review = implementing("review.txt", "the resolution's review\n");
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["resolve", "review", "gate"]);
  assert.ok(h.phases.includes("resolve") && !h.phases.includes("implement"), h.phases.join(", "));
  assert.deepEqual(
    h.passes.map((p) => p.name),
    [`resolve-${ID}`, `review-${ID}`],
  );
  // The narrow review reads what is new since the green head the first attempt ended on.
  assert.ok(h.passes[1].args.REVIEW_BASE, "the resolution's review is the narrow one");
  assert.equal(o.status, "green");
  assert.equal(o.reviewCommits, 2, "the first attempt's review commit and the resolution review's");
});

test("a resolution that changes a path git merged cleanly is held with the branch's commits and recorded gates", async () => {
  const h = await conflicted();
  const recorded = readHeads(h.root)[ID]?.gates;
  assert.deepEqual(recorded, GREEN.gates);
  h.agents.resolve = (wt) => {
    write(wt, "shared.txt", "one\nseven\n");
    // Another ticket's file, which the base merge took in cleanly: the resolution drops its line.
    write(wt, "review.txt", "");
    git(wt, "add", "shared.txt", "review.txt");
    git(wt, "commit", "-q", "--no-edit");
  };
  const o = await h.attempt();
  assert.deepEqual(h.events, ["resolve"], "held before any review or gate run");
  assert.equal(o.status, "held");
  assert.match(o.heldNote ?? "", /review\.txt/);
  assert.equal(o.commits, ownCommits("main", BRANCH, h.root));
  assert.ok(o.commits > 0);
  assert.deepEqual(o.gates, recorded);
  assert.equal(o.reviewCommits, 1, "the first attempt's review commit");
  // No `files`: the report reads files on a hold as a protected path ("changes X") and would hide the note.
  assert.equal("files" in o, false);
  assert.deepEqual(
    h.notes.map((x) => x.issue),
    [ID],
  );
});

test("a green head records its changelog lines and unmet criterion, and a later land-only run carries them", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt", "a\n", "Done.\n<changelog>Added: a key</changelog>\n<changelog>Fixed: a commit 3f2a9c1d in it</changelog>");
  h.agents.review = () => "<unmet>The second module still uses the old rule.</unmet>";
  h.gates.push(GREEN);
  const first = await h.attempt();
  assert.deepEqual(first.changelog, ["Added: a key"]);
  assert.equal(first.changelogDropped, 1, "a tag holding a commit sha is no changelog line");
  assert.equal(first.unmet, "The second module still uses the old rule.");
  const record = readHeads(h.root)[ID];
  assert.equal(record?.green, h.tip(BRANCH));
  assert.deepEqual(record?.changelog, ["Added: a key"]);
  assert.equal(record?.changelogDropped, 1);
  assert.equal(record?.unmet, "The second module still uses the old rule.");

  // A later run: the base moved, the branch is still at its green head. No agent speaks again.
  h.land("b.txt", "b\n");
  h.gates.push(GREEN);
  const later = await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
  assert.deepEqual(later.changelog, ["Added: a key"]);
  assert.equal(later.changelogDropped, 1);
  assert.equal(later.unmet, "The second module still uses the old rule.");
  assert.equal(readHeads(h.root)[ID]?.green, h.tip(BRANCH), "the new green head, the base merge on it");
  assert.equal(readHeads(h.root)[ID]?.unmet, "The second module still uses the old rule.");
});

// The full review judged the body alone and the implementer's line was dropped for it: the ticket closed
// with real work left. The line now reaches the review prompt, which asks for it finished or restated.
test("a full review is shown the implementer's unmet line, and a review that neither finishes nor restates it leaves it dropped", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt", "a\n", "<unmet>The owner's added scope in a comment is not done.</unmet>");
  h.agents.review = () => "All criteria met.";
  h.gates.push(GREEN);
  const o = await h.attempt();
  const review = h.passes.find((p) => p.name.startsWith("review-"));
  const shown = review?.args.IMPL_UNMET ?? "";
  assert.ok(shown.includes("The owner's added scope in a comment is not done."), "the review prompt carried the line");
  assert.match(shown, /finish it yourself, or restate it/i);
  assert.equal(o.unmet, undefined, "the reviewer's silence is its word, as before");
});

test("a review of an implementer that left nothing undone gets an empty IMPL_UNMET, and a narrow review never gets the line", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.repair = implementing("fix.txt", "fix\n");
  h.gates.push(red("FAIL: first"), GREEN);
  await h.attempt();
  assert.deepEqual(h.passes.filter((p) => p.name.startsWith("review-")).map((p) => p.args.IMPL_UNMET), ["", ""]);

  const g = harness();
  g.agents.impl = implementing("a.txt", "a\n", "<unmet>Left.</unmet>");
  g.agents.repair = implementing("fix.txt", "fix\n");
  g.gates.push(red("FAIL: first"), GREEN);
  await g.attempt();
  const reviews = g.passes.filter((p) => p.name.startsWith("review-"));
  assert.equal(reviews.length, 2);
  assert.match(reviews[0].args.IMPL_UNMET, /Left\./);
  assert.equal(reviews[1].args.IMPL_UNMET, "", "the review after a repair sees only the repair's commits");
});

test("a later green head with every criterion met drops the earlier one from the record", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt");
  h.agents.review = () => "<unmet>Not yet.</unmet>";
  h.gates.push(GREEN);
  await h.attempt();
  assert.equal(readHeads(h.root)[ID]?.unmet, "Not yet.");
  // New work on the branch since its green head: the full implement and review run, and this reviewer leaves nothing undone.
  h.onBranch("note.txt", "a person's commit\n");
  h.agents.impl = implementing("a.txt", "a, finished\n");
  h.agents.review = () => "";
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  assert.equal(o.unmet, undefined);
  assert.equal(readHeads(h.root)[ID]?.unmet, undefined);
});

// A reviewer whose only commit merged the base in read as `commits=1 (review=14)`: the pass's commit
// list counts the base commits its merge brought in, where `commits` counts the branch's own.
test("a reviewer that only merges the base in adds no review commits", async () => {
  const h = harness();
  h.agents.impl = (wt) => {
    commit(wt, "a.txt", "a\n");
    for (const f of ["b.txt", "c.txt", "d.txt"]) h.land(f, `${f}\n`);
  };
  h.agents.review = (wt) => void git(wt, "merge", "-q", "--no-edit", "main");
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(o.commits, 1);
  assert.equal(o.reviewCommits, 0);
});

test("a repair's review that gives one line adds it to the implementer's, and a full review's set replaces", async () => {
  const h = harness();
  h.agents.impl = implementing("a.txt", "a\n", "<changelog>Added: a key</changelog>\n<changelog>Fixed: a crash</changelog>");
  h.agents.repair = implementing("fix.txt", "fix\n");
  // The first review is the full one and restates the set with a rewording; the second sees only the repair commits.
  let reviews = 0;
  h.agents.review = () =>
    ++reviews === 2
      ? "<changelog>Changed: the report names the repair</changelog>"
      : "<changelog>Added: a key for the base</changelog>\n<changelog>Fixed: a crash</changelog>";
  h.gates.push(red("FAIL: first"), GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["impl", "review", "gate", "repair", "gate", "review"]);
  assert.deepEqual(o.changelog, ["Added: a key for the base", "Fixed: a crash", "Changed: the report names the repair"]);
});
