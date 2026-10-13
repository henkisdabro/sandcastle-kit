// A carried branch reviewed and green at a head, with a comment from a person on its ticket since that review,
// gets the full review (which shows the comments) after any merge resolution - not the narrow review, and not
// none. A comment the kit or an agent wrote does not count: the kit's have fixed openings, an agent's is inside
// the count recorded after its pass. The pipeline over a temp repo with scripted agents, gate runs and a ticket
// whose comments the test sets; no Docker, model, gh or network.
//
//   pnpm test:file test/carried-late-comment.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
// The merges pass process.env through to git, so an exported identity would win over config.
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { closeComment, commentCount, notLandedComment, partlyDoneComment, personCommentsSince } = await import("../src/ledger.ts");
const { readHeads, recordHead, renderPrompts } = await import("../src/run.ts");
const { namedStraysView } = await import("../src/resolution.ts");
const { AGENT_COMMENT_MARKER, makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
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
const ISSUE = { id: ID, title: "seven", body: "", comments: [] as string[] } as Parameters<ReturnType<typeof createPipeline>>[0];

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
  const passes: { name: string; prompt: string; args: Record<string, string> }[] = [];
  // The ticket's comments now, as the tracker reads them: a test (or an agent in its pass) appends to it.
  const comments: string[] = [];
  // What the last attempt printed.
  const printed: string[] = [];
  const phases: string[] = [];
  const agents: Record<string, Agent> = {};
  const gates: GateRun[] = [];
  // What happens as a gate run starts, one per run in order: a person's comment arriving while the gates run.
  const duringGates: (() => void)[] = [];

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
      run: async (opts: { name?: string; promptFile?: string; promptArgs?: Record<string, string> }) => {
        const name = opts.name ?? "";
        const kind = name.split("-")[0];
        events.push(kind);
        passes.push({ name, prompt: basename(opts.promptFile ?? "", ".md"), args: opts.promptArgs ?? {} });
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
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false, get: () => ({ id: ID, comments: [...comments] }) } as unknown as Ctx["tracker"],
    runId: "2026-10-04T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
      events.push("gate");
      duringGates.shift()?.();
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
    const { result: o, lines } = await quietly(() => pipeline({ ...ISSUE, comments: [...comments] }));
    printed.splice(0, printed.length, ...lines);
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
  return { root, agents, gates, events, passes, phases, notes, reds, comments, duringGates, printed, attempt, requeue, land, tip, onBranch };
};


/** An implementer that commits `file`, saying `say`. */
const implementing = (file: string, text = `${file}\n`, say = ""): Agent => (wt) => {
  commit(wt, file, text);
  return say;
};

/** A first attempt: implemented, reviewed and gated green on a branch, the ticket having `comments` then. */
const greenBranch = async (comments: string[] = []) => {
  const h = harness();
  h.comments.push(...comments);
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.gates.push(GREEN);
  const first = await h.attempt();
  assert.equal(first.status, "green");
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  return h;
};

/** The resolution of a conflict in shared.txt, as a resolver makes it. */
const resolving: Agent = (wt) => {
  write(wt, "shared.txt", "one\nseven\n");
  git(wt, "add", "shared.txt");
  git(wt, "commit", "-q", "--no-edit");
};

const SPEC_CHANGE = "Having it also read `flaked` is wanted after all - please change the design.";

test("a person's comment since the review sends a clean carried merge through the full review before the gates", async () => {
  const h = await greenBranch();
  h.land("landed.txt", "another ticket's line\n");
  h.comments.push(SPEC_CHANGE);
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
  assert.equal(h.passes[0].prompt, "review");
  assert.equal(o.status, "green");
  assert.equal(readHeads(h.root)[ID].comments, 1);
});

test("a person's comment on a carried branch at its green head, with no merge, gets the full review", async () => {
  const h = await greenBranch();
  h.comments.push(SPEC_CHANGE);
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
  assert.equal(h.passes[0].prompt, "review");
});

test("the kit's own comment on the ticket since the review leaves a clean carried merge land-only", async () => {
  const h = await greenBranch();
  h.land("landed.txt", "another ticket's line\n");
  h.comments.push(notLandedComment(undefined, { branch: BRANCH, base: "main", files: ["shared.txt"], with: ["#1"] })!);
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
  assert.equal(o.status, "green");
});

const AGENT_SAID = `${AGENT_COMMENT_MARKER} the review found nothing to change.`;

test("a comment an agent wrote during its pass, opening with the kit's marker, sends a clean carried merge nowhere but the gates", async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.agents.review = () => {
    h.comments.push(AGENT_SAID);
  };
  h.gates.push(GREEN);
  await h.attempt();
  // The count is read before the review pass starts: the agent's comment is past it and skipped by its marker.
  assert.equal(readHeads(h.root)[ID].comments, 0);
  h.land("landed.txt", "another ticket's line\n");
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
});

test("a person's comment after an agent's is still told, by its place past the recorded count", async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.agents.review = () => {
    h.comments.push(AGENT_SAID);
  };
  h.gates.push(GREEN);
  await h.attempt();
  h.comments.push(SPEC_CHANGE);
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
});

test("a conflicted carried merge with a person's comment since gets the full review after the resolver, not the narrow one", async () => {
  const h = await greenBranch();
  h.land("shared.txt", "one\n");
  h.comments.push(SPEC_CHANGE);
  h.agents.resolve = resolving;
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.deepEqual(h.events, ["resolve", "review", "gate"]);
  assert.deepEqual(h.passes.map((p) => p.prompt), ["resolve", "review"]);
  assert.equal(o.status, "green");
});

test("a conflicted carried merge with no new comment still gets the narrow review after the resolver", async () => {
  const h = await greenBranch();
  h.land("shared.txt", "one\n");
  h.agents.resolve = resolving;
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.passes.map((p) => p.prompt), ["resolve", "remerge"]);
});

test("a person's comment is acted on once: the full review records the new count, and the next carry is land-only", async () => {
  const h = await greenBranch();
  h.comments.push(SPEC_CHANGE);
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
  h.land("landed.txt", "another ticket's line\n");
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
});

test("a head record from before the count was kept never sends a carried branch to a full review", async () => {
  const h = await greenBranch();
  recordHead(h.root, ID, { branch: BRANCH, comments: undefined }, "2026-10-04T00:00:00.000Z");
  h.comments.push(SPEC_CHANGE);
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
});

test("the carried line says a comment since the review sends it to the full review", async () => {
  const h = await greenBranch();
  h.comments.push(SPEC_CHANGE);
  h.gates.push(GREEN);
  await h.attempt();
  assert.match(h.printed.join("\n"), /a comment since its review - full review/);
});

test("the kit's own comments are told from a person's by their fixed openings", () => {
  const kit = [
    notLandedComment("the report", undefined)!,
    notLandedComment(undefined, { branch: BRANCH, base: "main", files: ["a.txt"], with: ["#1"] })!,
    notLandedComment(undefined, undefined, { branch: BRANCH, base: "main", with: ["#1"], gates: ["test"] })!,
    closeComment({ branch: BRANCH, commits: 1, repairs: 0 }, "test"),
    partlyDoneComment({ branch: BRANCH, commits: 1, repairs: 0, unmet: "the docs" }, "test"),
    "Sandcastle held this: conflict resolution changed other.txt.",
    "Sandcastle could not finish this.\n\nblocked",
    "Gated green on `agent/issue-7` (test), but not merged automatically: review and merge by hand.",
    'Named again by the review agent working on #3, as the same finding, worded "x":\n\nevidence',
    "Merged into `main` by an earlier Sandcastle run (abc1234); closing.",
    "Merged locally, not yet pushed, by `sandcastle land` from `agent/issue-7` (1 commit(s)); test all green on the merge.",
  ];
  assert.deepEqual(personCommentsSince(kit, 0), []);
  assert.deepEqual(personCommentsSince([...kit, SPEC_CHANGE], 0), [SPEC_CHANGE]);
  // The note of `sandcastle requeue --note` is a person's word.
  const note = "Note for the next run, from `sandcastle requeue`:\n\nuse the other design";
  assert.deepEqual(personCommentsSince(["first", note], 1), [note]);
  // Only those past the count recorded.
  assert.deepEqual(personCommentsSince(["old one", "old two"], 2), []);
  assert.deepEqual(personCommentsSince(["old one"], undefined), []);
});

test("a comment opening with the agent marker is the kit's, whatever follows it, and one that only mentions it is a person's", () => {
  const agent = `${AGENT_COMMENT_MARKER}\n\nGate output:\n\n    1 failing`;
  assert.deepEqual(personCommentsSince([agent], 0), []);
  assert.deepEqual(personCommentsSince(["old", agent, SPEC_CHANGE], 1), [SPEC_CHANGE]);
  const mention = `Please start your comments with "${AGENT_COMMENT_MARKER}" as asked.`;
  assert.deepEqual(personCommentsSince([mention], 0), [mention]);
});

test("a person's comment while the ticket's gates run is not absorbed by the green write: the next carry gets the full review", async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.duringGates.push(() => h.comments.push(SPEC_CHANGE));
  h.gates.push(GREEN);
  const first = await h.attempt();
  assert.equal(first.status, "green");
  assert.deepEqual(h.events, ["impl", "review", "gate"]);
  h.land("landed.txt", "another ticket's line\n");
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
  assert.equal(h.passes[0].prompt, "review");
});

test("a person's comment during a repair pass is not absorbed by the repaired write: the next carry gets the full review", async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.agents.repair = (wt) => {
    h.comments.push(SPEC_CHANGE);
    commit(wt, "fix.txt", "fix\n");
  };
  const failure = { name: "test", command: "run-tests", exitCode: 1, output: "1 failing" };
  h.gates.push({ gates: [{ name: "test", pass: false }], failure, failures: [failure] }, GREEN);
  const first = await h.attempt();
  assert.equal(first.status, "green");
  assert.ok(h.events.includes("repair"), h.events.join(","));
  h.land("landed.txt", "another ticket's line\n");
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
});

test("an agent's marked comment during the gates or a repair leaves the next clean carried merge land-only", async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.agents.repair = (wt) => {
    h.comments.push(AGENT_SAID);
    commit(wt, "fix.txt", "fix\n");
  };
  const failure = { name: "test", command: "run-tests", exitCode: 1, output: "1 failing" };
  h.gates.push({ gates: [{ name: "test", pass: false }], failure, failures: [failure] }, GREEN);
  h.duringGates.push(() => {}, () => h.comments.push(AGENT_SAID));
  await h.attempt();
  h.land("landed.txt", "another ticket's line\n");
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["gate"]);
});

test("a person's comment before the narrow review of a conflict resolution still sends the next carry to the full review", async () => {
  const h = await greenBranch();
  h.land("shared.txt", "one\n");
  h.agents.resolve = (wt) => {
    h.comments.push(SPEC_CHANGE);
    return resolving(wt);
  };
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.passes.map((p) => p.prompt), ["resolve", "remerge"]);
  h.land("landed.txt", "another ticket's line\n");
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
  assert.equal(h.passes[0].prompt, "review");
});

test("a person's comment before the narrow review of a base merge still sends the next carry to the full review", async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  const failure = { name: "test", command: "run-tests", exitCode: 1, output: "1 failing" };
  const red = { gates: [{ name: "test", pass: false }], failure, failures: [failure] };
  // The repair pass commits nothing, and the gates run once more on the unchanged branch.
  h.gates.push(red, red);
  const first = await h.attempt();
  assert.equal(first.status, "gate-failed");
  // Red, so the next attempt is not land-only: the implementer runs, and the base merge since the review gets the narrow one.
  h.land("landed.txt", "another ticket's line\n");
  h.agents.impl = () => {
    h.comments.push(SPEC_CHANGE);
  };
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.passes.map((p) => p.prompt), ["implement", "remerge"]);
  h.land("other.txt", "a third ticket's line\n");
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.events, ["review", "gate"]);
  assert.equal(h.passes[0].prompt, "review");
});

test("a Markdown ticket file's comments count by their headings, the kit's marked by theirs", () => {
  const section = (...entries: string[]) => `## Comments\n\n${entries.join("\n")}`;
  const kit = "### 2026-10-01 - sandcastle\n\nA comment of the kit, which has no fixed opening here.\n";
  const person = "### 2026-10-02 - maintainer\n\nChange the design.\n";
  assert.equal(commentCount([]), 0);
  assert.equal(commentCount([section(kit, person)]), 2);
  assert.deepEqual(personCommentsSince([section(kit, person)], 1), ["Change the design."]);
  assert.deepEqual(personCommentsSince([section(kit)], 0), []);
});

/** The resolution of the conflict in shared.txt that also changes landed.txt, which the base added and the branch never had. */
const resolvingAlso = (say: string): Agent => (wt) => {
  write(wt, "shared.txt", "one\nseven\n");
  write(wt, "landed.txt", "another ticket's line, adapted\n");
  git(wt, "add", "shared.txt", "landed.txt");
  git(wt, "commit", "-q", "--no-edit");
  return say;
};

test("the full review of a conflicted carried merge with a late comment is shown the cleanly merged file the resolver named, and why", async () => {
  const h = await greenBranch();
  h.land("shared.txt", "one\n");
  h.land("landed.txt", "another ticket's line\n");
  h.comments.push(SPEC_CHANGE);
  h.agents.resolve = resolvingAlso('<stray path="landed.txt">the landed assertion pinned the sentence this ticket replaces</stray>');
  h.gates.push(GREEN);
  const o = await h.attempt();
  assert.equal(o.status, "green");
  assert.deepEqual(h.passes.map((p) => p.prompt), ["resolve", "review"]);
  const shown = h.passes[1].args.MERGE_STRAYS;
  assert.match(shown, /`landed\.txt` - the landed assertion pinned the sentence this ticket replaces/);
  // The full review is shown no combined diff: it is told the command that shows each stray instead.
  assert.match(shown, /git diff <merge>\^2 <merge> -- <file>/);
  assert.doesNotMatch(shown, /diff above/);
});

test("the narrow review's strays still point at the combined diff above", async () => {
  const h = await greenBranch();
  h.land("shared.txt", "one\n");
  h.land("landed.txt", "another ticket's line\n");
  h.agents.resolve = resolvingAlso('<stray path="landed.txt">adapted to the merge</stray>');
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.passes.map((p) => p.prompt), ["resolve", "remerge"]);
  assert.match(h.passes[1].args.MERGE_STRAYS, /combined diff above/);
});

test("a first-attempt full review gets no strays heading", async () => {
  const h = harness();
  h.agents.impl = implementing("shared.txt", "seven\n");
  h.gates.push(GREEN);
  await h.attempt();
  assert.deepEqual(h.passes.map((p) => p.prompt), ["implement", "review"]);
  assert.equal(h.passes[1].args.MERGE_STRAYS, "");
});

test("a late comment on a conflicted merge whose resolver named nothing gives the full review an empty strays slot", async () => {
  const h = await greenBranch();
  h.land("shared.txt", "one\n");
  h.comments.push(SPEC_CHANGE);
  h.agents.resolve = resolving;
  h.gates.push(GREEN);
  await h.attempt();
  assert.equal(h.passes[1].args.MERGE_STRAYS, "");
});

test("the rendered review prompt holds the strays slot, and filled in it never points at a combined diff above", () => {
  const root = mkdtempSync(join(TMP, "render-"));
  const p = { root, name: "fixture", label: "fixture", gates: [{ name: "test", command: "run-tests" }], tracker: fakeTracker() } as unknown as Parameters<typeof renderPrompts>[0];
  const text = readFileSync(renderPrompts(p, makeTracker(p)).review, "utf8");
  assert.equal(text.split("{{MERGE_STRAYS}}").length - 1, 1);
  // Before "What to look for", where the ticket and the diff are.
  assert.ok(text.indexOf("{{MERGE_STRAYS}}") < text.indexOf("# What to look for"));
  const filled = text.replace("{{MERGE_STRAYS}}", () => namedStraysView([{ path: "landed.txt", why: "adapted" }], "full"));
  assert.match(filled, /`landed\.txt` - adapted/);
  assert.doesNotMatch(filled, /diff above/);
});
