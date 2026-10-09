// A carried branch that merged a base which has since been rewritten (a `git pull --rebase` that
// flattened the previous run's landing merges into copies, a reset that dropped a landing) holds
// commits the base no longer has under their old hashes. Landing it as it stands brings them back
// as duplicates, or a commit someone removed on purpose, with no review. The pipeline
// (`createPipeline`, src/burndown.ts) re-creates such a branch on the current base from its own
// non-merge commits, drops its head record so a full review and the gates follow, and holds it for
// a person when a commit does not apply. Real git in a temp repo, a host worktree as the sandbox,
// scripted agents and gate runs; no Docker, model or network.
//
//   pnpm test:file test/carried-rewritten-base.test.ts

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
const { branchFiles, createPipeline } = await import("../src/burndown.ts");
const { landOnlyHead, narrowReviewBase, readHeads, reviewedOnlyHead } = await import("../src/run.ts");
const { ownCommits } = await import("../src/sandbox.ts");
const { rebuildOnBase } = await import("../src/resolution.ts");
const { hostIdentity } = await import("../src/generated.ts");
const { createHostGit, landOne } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Facts = import("../src/report.ts").Facts;
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Outcome = Awaited<ReturnType<ReturnType<typeof createPipeline>>>;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-rewritten-base-"));
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

/** A project in a temp repo and a pipeline over it, every port faked: the sandbox is a host worktree that runs git alone. */
const harness = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n", "start");
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      const file = join(root, `.sandcastle/.run/${kind}.md`);
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}} {{REVIEW_BASE}} {{REPAIR_BASE}}\n");
      return [kind, file];
    }),
  ) as Ctx["prompts"];
  const events: string[] = [];
  const gates: GateRun[] = [];
  const agents: Record<string, (worktree: string) => void> = {};

  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    return {
      worktreePath: path,
      // Git alone: what else the pipeline asks a sandbox (its memory peak) the fake does not have.
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const kind = (opts.name ?? "").split("-")[0];
        events.push(kind);
        const before = git(path, "rev-parse", "HEAD");
        agents[kind]?.(path);
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
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
    gate: async () => {
      events.push("gate");
      const next = gates.shift();
      assert.ok(next, "a gate run the test did not expect");
      return next;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue, _phase, fn) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results: [],
    reds: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });

  /** One attempt of the ticket: what it printed, what the agents and gates ran, in order. */
  const attempt = async (): Promise<{ o: Outcome; lines: string[]; events: string[] }> => {
    events.length = 0;
    const { result: o, lines } = await quietly(() => pipeline(ISSUE));
    return { o, lines, events: [...events] };
  };

  /** Another ticket lands on main as the kit lands one: its branch merged with `--no-ff`. */
  const land = (file: string, text = `${file}\n`) => {
    const side = `agent/issue-land-${n++}`;
    git(root, "checkout", "-q", "-b", side, "main");
    commit(root, file, text, `work on ${file}`);
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", `Merge ${side} (closes #${n})`, side);
  };
  /** What `git pull --rebase` makes of the landing merges since `from`: their non-merge commits replayed, one by one, as copies. */
  const flatten = (from: string) => {
    const picks = git(root, "rev-list", "--reverse", "--no-merges", `${from}..main`).split("\n").filter(Boolean);
    git(root, "reset", "-q", "--hard", from);
    for (const sha of picks) execFileSync("git", ["cherry-pick", sha], { cwd: root, stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: "2031-01-01T00:00:00Z" } });
  };
  const tip = (ref: string) => git(root, "rev-parse", ref);
  const has = (ref: string, file: string) => spawnSync("git", ["cat-file", "-e", `${ref}:${file}`], { cwd: root }).status === 0;
  return { root, agents, gates, attempt, land, flatten, tip, has };
};

/** A ticket whose branch has one commit of its own (`a.txt`), reviewed and green; main then gains `landings` and the branch merges it in, green again. */
const carried = async (landings: string[]) => {
  const h = harness();
  h.agents.impl = (wt) => commit(wt, "a.txt", "a\n", "the ticket's work");
  h.gates.push(GREEN);
  assert.equal((await h.attempt()).o.status, "green");
  // The work is done: an implementer that runs again finds nothing to add.
  h.agents.impl = () => {};
  const start = h.tip("main");
  for (const f of landings) h.land(f);
  h.gates.push(GREEN);
  const second = await h.attempt();
  assert.deepEqual(second.events, ["gate"], "an unrewritten base: land only, the base merged in");
  const head = h.tip(BRANCH);
  assert.equal(readHeads(h.root)[ID]?.green, head, "the merge of the base is inside the head the gates vouched for");
  return { h, start, head };
};

test("a branch carried across a flattened base counts and lists only its own work, and no recorded head vouches for it", async () => {
  const { h, start, head } = await carried(["b.txt", "c.txt"]);
  h.flatten(start);
  // The kit's own merge of the old base is still in the branch: 2 landed commits, flattened into copies, are not its work.
  assert.equal(ownCommits("main", BRANCH, h.root), 1);
  assert.deepEqual(branchFiles(h.root, "main", ID), ["a.txt"]);
  assert.equal(landOnlyHead(h.root, "main", ID), undefined);
  assert.equal(reviewedOnlyHead(h.root, "main", ID), undefined);
  assert.equal(narrowReviewBase(h.root, "main", ID), undefined);
  assert.equal(h.tip(BRANCH), head, "nothing moved on the host");
});

test("a branch carried across a flattened base is re-created on the new base, reviewed in full and gated", async () => {
  const { h, start, head } = await carried(["b.txt", "c.txt"]);
  const landedBefore = git(h.root, "rev-list", "--no-merges", `${start}..main`).split("\n");
  h.flatten(start);
  h.gates.push(GREEN);
  const { o, lines, events } = await h.attempt();

  // The full pipeline, not the land-only one the recorded green head would have taken.
  assert.deepEqual(events, ["impl", "review", "gate"]);
  assert.equal(o.status, "green");
  assert.equal(o.commits, 1);
  // The branch is main plus its own commit: no copy of a landing, no merge of the old base, and none of the old commits.
  assert.equal(git(h.root, "rev-list", "--count", `main..${BRANCH}`), "1");
  assert.equal(git(h.root, "rev-list", "--count", `${BRANCH}..main`), "0");
  assert.equal(git(h.root, "log", "--format=%s", `main..${BRANCH}`), "the ticket's work");
  assert.deepEqual(git(h.root, "cherry", "main", BRANCH).split("\n"), [`+ ${h.tip(BRANCH)}`]);
  for (const sha of [...landedBefore, head]) assert.notEqual(spawnSync("git", ["merge-base", "--is-ancestor", sha, BRANCH], { cwd: h.root }).status, 0, `${sha.slice(0, 7)} is back on the branch`);
  // Every file of the base and the ticket is there.
  for (const f of ["shared.txt", "a.txt", "b.txt", "c.txt"]) assert.ok(h.has(BRANCH, f), f);
  // The head record now names the rebuilt branch, not the old green head.
  assert.notEqual(readHeads(h.root)[ID]?.green, head);
  assert.equal(readHeads(h.root)[ID]?.green, h.tip(BRANCH));
  // The run says why, and names the old tip so a person can find it.
  const why = lines.find((l) => /rewritten/.test(l));
  assert.ok(why, lines.join("\n"));
  assert.match(why, /#7/);
  assert.ok(why.includes(head.slice(0, 7)), why);
});

test("a branch carried across a reset base does not bring back the landing the reset removed", async () => {
  // `git cherry` alone cannot see this one: the removed landing's commit has no copy on the base, so it reads as the branch's own.
  const h = harness();
  h.agents.impl = (wt) => commit(wt, "a.txt", "a\n", "the ticket's work");
  h.gates.push(GREEN);
  assert.equal((await h.attempt()).o.status, "green");
  h.agents.impl = () => {};
  h.land("good.txt");
  const good = h.tip("main");
  h.land("bad.txt");
  h.gates.push(GREEN);
  assert.deepEqual((await h.attempt()).events, ["gate"]);
  assert.ok(h.has(BRANCH, "bad.txt"));

  // The maintainer drops the bad landing.
  git(h.root, "reset", "-q", "--hard", good);
  assert.equal(ownCommits("main", BRANCH, h.root), 1);
  assert.equal(landOnlyHead(h.root, "main", ID), undefined);

  h.gates.push(GREEN);
  const { o, events } = await h.attempt();
  assert.deepEqual(events, ["impl", "review", "gate"]);
  assert.equal(o.commits, 1);
  assert.equal(h.has(BRANCH, "bad.txt"), false, "the removed landing came back");
  assert.ok(h.has(BRANCH, "good.txt") && h.has(BRANCH, "a.txt"));
  assert.equal(git(h.root, "rev-list", "--count", `main..${BRANCH}`), "1");
});

test("a rewritten base the branch's commits do not apply to holds the branch for a person, untouched, with the cause named", async () => {
  const h = harness();
  h.agents.impl = (wt) => commit(wt, "shared.txt", "seven\n", "the ticket's work");
  h.gates.push(GREEN);
  assert.equal((await h.attempt()).o.status, "green");
  const start = h.tip("main");
  h.land("b.txt");
  h.gates.push(GREEN);
  await h.attempt();
  const head = h.tip(BRANCH);
  // The base is rewritten: the landing is gone and another ticket's change to the same line stands in its place.
  git(h.root, "reset", "-q", "--hard", start);
  commit(h.root, "shared.txt", "one\n", "another ticket's change");

  const { o, lines, events } = await h.attempt();
  assert.deepEqual(events, [], "no agent and no gate run on a branch held before they start");
  assert.equal(o.status, "held");
  assert.match(o.heldNote ?? "", /rewritten/);
  assert.match(o.heldNote ?? "", /shared\.txt/);
  assert.ok(lines.some((l) => /held for a human/.test(l)), lines.join("\n"));
  // Nothing was rebuilt: the branch is as the earlier run left it, and the sandbox left no pick half done.
  assert.equal(h.tip(BRANCH), head);
  assert.equal(o.commits, 1, "its own commits, not the old base's");
  assert.equal(git(h.root, "branch", "--list", BRANCH).replace(/^[*+]?\s*/, ""), BRANCH, "the branch is still a branch, not a detached head");
});

test("a base that only moved forward is no rewrite: the branch keeps its head record and lands as before", async () => {
  const { h, head } = await carried(["b.txt", "c.txt"]);
  assert.equal(landOnlyHead(h.root, "main", ID), head);
  assert.equal(ownCommits("main", BRANCH, h.root), 1);
  h.land("d.txt");
  h.gates.push(GREEN);
  const { events, lines } = await h.attempt();
  assert.deepEqual(events, ["gate"]);
  assert.ok(!lines.some((l) => /rewritten/.test(l)), lines.join("\n"));
  // The earlier merge of the base is still in the branch's history.
  assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", head, BRANCH], { cwd: h.root }).status, 0);
});

/** The sandbox as a host worktree on the branch, running git alone: what `rebuildOnBase` is given. */
const sandboxOn = (root: string, branch: string) => {
  const path = join(TMP, `wt${n++}`);
  git(root, "worktree", "add", "-q", path, branch);
  const exec = async (cmd: string) => {
    const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  return { path, exec };
};

/** A branch with one commit of its own that merged main, and main rewritten after: what `rebuildOnBase` is for. */
const rewritten = (own: { file: string; text: string }, onMain: (root: string) => void) => {
  const h = harness();
  git(h.root, "branch", BRANCH, "main");
  const side = sandboxOn(h.root, BRANCH);
  commit(side.path, own.file, own.text, "the ticket's work");
  const start = h.tip("main");
  h.land("b.txt");
  git(side.path, "merge", "-q", "--no-ff", "-m", "Merge main into the branch", "main");
  git(h.root, "worktree", "remove", "--force", side.path);
  h.flatten(start);
  onMain(h.root);
  return h;
};

test("a rebuild that stops on a conflict leaves the sandbox on the branch, clean, with no pick half done", async () => {
  const h = rewritten({ file: "shared.txt", text: "seven\n" }, (root) => commit(root, "shared.txt", "one\n", "another ticket's change"));
  const was = h.tip(BRANCH);
  const box = sandboxOn(h.root, BRANCH);
  const rebuilt = await rebuildOnBase(box, { root: h.root, base: "main", branch: BRANCH, identity: hostIdentity(h.root) });
  assert.equal(rebuilt?.kind, "held");
  assert.match(rebuilt?.kind === "held" ? rebuilt.why : "", /its commit [0-9a-f]{7} conflicts with main in shared\.txt/);
  assert.equal(h.tip(BRANCH), was);
  assert.equal(git(box.path, "symbolic-ref", "HEAD"), `refs/heads/${BRANCH}`);
  assert.equal(git(box.path, "status", "--porcelain"), "");
  assert.equal(spawnSync("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], { cwd: box.path }).status, 1, "a cherry-pick is still in progress");
});

test("a branch commit whose work the new base already has is left out of the rebuilt branch", async () => {
  // Another ticket made the same change to the rewritten base: the pick would be empty.
  const h = rewritten({ file: "a.txt", text: "a\n" }, (root) => commit(root, "a.txt", "a\n", "the same change, by another ticket"));
  const box = sandboxOn(h.root, BRANCH);
  const rebuilt = await rebuildOnBase(box, { root: h.root, base: "main", branch: BRANCH, identity: hostIdentity(h.root) });
  assert.deepEqual(rebuilt && { kind: rebuilt.kind, ...(rebuilt.kind === "rebuilt" && { picked: rebuilt.picked, dropped: rebuilt.dropped }) }, { kind: "rebuilt", picked: 0, dropped: 1 });
  assert.equal(h.tip(BRANCH), h.tip("main"));
  assert.equal(git(box.path, "symbolic-ref", "HEAD"), `refs/heads/${BRANCH}`);
  assert.equal(git(box.path, "status", "--porcelain"), "");
});

test("a branch whose base only moved forward is left alone", async () => {
  const h = harness();
  git(h.root, "branch", BRANCH, "main");
  const side = sandboxOn(h.root, BRANCH);
  commit(side.path, "a.txt", "a\n", "the ticket's work");
  h.land("b.txt");
  git(side.path, "merge", "-q", "--no-ff", "-m", "Merge main into the branch", "main");
  const was = h.tip(BRANCH);
  assert.equal(await rebuildOnBase(side, { root: h.root, base: "main", branch: BRANCH, identity: hostIdentity(h.root) }), undefined);
  assert.equal(h.tip(BRANCH), was);
});

test("a branch that reaches landing over a rewritten base is not merged", async () => {
  // The pipeline re-creates it before its gates; this is the landing's own check, for a rewrite made after them.
  const { h, start, head } = await carried(["b.txt", "c.txt"]);
  h.flatten(start);
  const before = h.tip("main");
  const calls: string[] = [];
  const project = { root: h.root, name: "fixture", baseBranch: "main", land: "merge", generated: [], gates: [], setup: [] } as unknown as Parameters<typeof createHostGit>[0];
  const landed = await landOne(
    {
      project,
      tracker: { ref: (id: string) => `#${id}`, close: () => void calls.push("close"), hold: () => void calls.push("hold"), get: () => ({ body: "" }) } as unknown as import("../src/landing.ts").LandContext["tracker"],
      base: "main",
      gateNames: "test",
      reports: new Map(),
      run: { ticket: () => {} },
      dryRun: false,
      opener: async () => assert.fail("no sandbox was expected"),
      withdrawal: () => undefined,
      host: createHostGit(project, gitFingerprint(project)),
      gate: async () => assert.fail("no gate run was expected"),
      landed: new Map(),
    },
    { issue: ID, branch: BRANCH, status: "green", commits: 1, repairs: 0, head },
  );
  assert.equal(landed.kind, "skipped");
  assert.match(landed.kind === "skipped" ? landed.reason : "", /rewritten/);
  assert.deepEqual(calls, []);
  assert.equal(h.tip("main"), before);
});

// The closing summary. A branch the kit held for a rewritten base is never advised as a merge: merged as it stands it is the bug.

const NOTE = "base rewritten under the branch - it merged e266cf3, which main no longer holds, and its commit cef641f conflicts with main in shared.txt; the branch is left as it was (8c199e0)";

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-10-09T06:41:00.000Z",
  finished: "2026-10-09T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 1,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const section = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("the push step warns that a plain pull --rebase flattens the run's merges, and only when there is something to push", () => {
  const next = section(render(facts({ ahead: 4, upstream: "origin/main" })), "## 👉 Next step");
  assert.match(next, /Push main \(4 commit\(s\)\) under this repo's rules before the next run/);
  assert.match(next, /`git pull --rebase`, which flattens this run's landing merges into copies \(`--rebase=merges` keeps them\)/);
  assert.match(next, /carried to the next run that merged the old main is then re-created from its own commits and reviewed in full/);
  assert.doesNotMatch(section(render(facts({ ahead: 0, upstream: "origin/main" })), "## 👉 Next step"), /pull --rebase/);
});

test("a branch held for a rewritten base is rebuilt by hand, not merged, in this run's summary", () => {
  const out = render(
    facts({
      standing: ["agent/issue-1", "agent/issue-2"],
      changed: { "1": 2, "2": 1 },
      heldRewritten: ["1"],
      tickets: {
        "1": { state: "held", title: "rewritten", note: NOTE },
        "2": { state: "held", title: "protected", note: "changes how the repo executes", files: [".githooks/pre-push"] },
      },
    }),
    true,
  );
  const needs = section(out, "## Needs you");
  assert.match(needs, /- #1 rewritten - base rewritten under the branch - it merged e266cf3, which main no longer holds/);
  assert.match(needs, /\n {2}review: git log -p --no-merges agent\/issue-1 \^main \^<old main> {3}rebuild: git rebase --onto main <old main> agent\/issue-1 /);
  assert.doesNotMatch(needs, /git merge --no-ff agent\/issue-1\b/);
  // A protected-path hold beside it is merged by hand, as before.
  assert.match(needs, /- #2 protected - .*\n {2}review: git log -p main\.\.agent\/issue-2 {3}merge: git merge --no-ff agent\/issue-2\n/);
  const next = section(out, "## Next step");
  assert.match(next, /Review and merge the 1 held branch\(es\)/);
  assert.match(next, /Rebuild the 1 held branch\(es\) on the rewritten main \(commands above\), then `sandcastle requeue <ticket>` for a run to review and land it\./);
});

test("an earlier run's rewritten-base hold is rebuilt, not merged by hand", () => {
  const out = render(facts({ standing: ["agent/issue-7", "agent/issue-8"], earlierHeld: { "agent/issue-7": `needs a human: ${NOTE}`, "agent/issue-8": "needs a human merge" }, heldRewritten: ["7"] }));
  const state = section(out, "## 📤 Local state");
  assert.match(state, /agent\/issue-7 \(held in an earlier run: base rewritten under the branch - it merged e266cf3/);
  assert.doesNotMatch(state, /agent\/issue-7 \(held for a human merge/);
  assert.match(state, /agent\/issue-8 \(held for a human merge in an earlier run\)/);
  const next = section(out, "## 👉 Next step");
  assert.match(next, /Rebuild agent\/issue-7 on the rewritten main, held in an earlier run: merged as it stands, it would bring back what the rewrite removed\. `git rebase --onto main <old main> agent\/issue-7` \(the old main is named in the hold note\), then `sandcastle requeue 7` for a run to review and land it\./);
  assert.match(next, /Resolve agent\/issue-8, held for a human merge in an earlier run/);
  assert.doesNotMatch(next, /git merge --no-ff agent\/issue-7/);
});

test("gather lists the tickets whose hold is a rewritten base, and no other hold", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-rewritten-hold-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  for (const id of ["7", "8"]) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    commit(root, `work-${id}.txt`, "work\n");
  }
  git(root, "checkout", "-q", "main");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const earlier = "2026-10-08T08:00:00.000Z";
  writeFileSync(join(root, ".sandcastle/logs/outcomes.json"), JSON.stringify({ "7": { run: earlier, kind: "held", text: `needs a human: ${NOTE}` }, "8": { run: earlier, kind: "held", text: "needs a human merge" } }));
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: "2026-10-09T08:00:00.000Z", finishedAt: "2026-10-09T09:00:00.000Z", exitCode: 0, stage: "report", tickets: {} }));
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Parameters<typeof gather>[0];
  const gathered = await gather(project, () => undefined);
  assert.deepEqual(gathered.heldRewritten, ["7"]);
  assert.deepEqual(gathered.heldResolutions, []);
});
