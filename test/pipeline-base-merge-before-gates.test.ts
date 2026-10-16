// The base tip is merged into the agent branch in the ticket's sandbox just before its gates (#790 option b), only when
// the branch is behind: the gate port then sees a head that holds the base tip, and a landing with no landing in between
// fast-forwards it in place with no landing gate (`landOne`'s "branch holds the base's tip" rule). A landing in between
// still gates. A merge that conflicts, is refused or whose setup fails is undone and the branch is gated as it stands.
// The pipeline (`createPipeline`) runs over faked ports as test/pipeline-conflict-before-landing.test.ts does, the landing
// is the real `landOne` with a counting `ctx.gate` as test/landing-claim-gates.test.ts does. No Docker, model, gh or network.
//
//   pnpm test:file test/pipeline-base-merge-before-gates.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { createHostGit, landOne, touchesOverrun } = await import("../src/landing.ts");
const { gitFingerprint } = await import("../src/guard.ts");
type PCtx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type Issue = Parameters<ReturnType<typeof createPipeline>>[0];
type GateRun = import("../src/gates.ts").GateRun;
type LCtx = import("../src/landing.ts").LandContext;
type Project = import("../src/config.ts").Project;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-base-merge-"));
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
const issue = { id: ID, title: "ticket 7", body: "" } as Issue;
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };

/** A project in a temp repo and a pipeline over it with every port faked; `gated` is each head the gate port was handed. */
const harness = (o: { setup?: string[]; beforeMerge?: (worktree: string) => void } = {}) => {
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
  ) as PCtx["prompts"];
  const gated: { head: string; mergeHead: boolean; files: string[] }[] = [];
  const agents: Record<string, (worktree: string) => void> = {};

  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).status === 0;
    if (exists) git(root, "worktree", "add", "-q", path, branch);
    else git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    const box = {
      worktreePath: path,
      exec: async (cmd: string) => {
        // The base moves between `conflictBefore`'s read and the sandbox's merge.
        if (/ merge --no-edit /.test(cmd)) o.beforeMerge?.(path);
        const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const before = git(path, "rev-parse", "HEAD");
        agents[(opts.name ?? "").split("-")[0]]?.(path);
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: "", commits };
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
    setup: o.setup ?? [],
    implement: {},
    review: {},
    repair: {},
  } as unknown as PCtx["project"];
  const results: PromiseSettledResult<unknown>[] = [];
  const pipeline = createPipeline({
    project,
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as PCtx["tracker"],
    runId: "2026-10-07T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async (box: Box) => {
      const wt = (box as unknown as { worktreePath: string }).worktreePath;
      gated.push({
        head: git(wt, "rev-parse", "HEAD"),
        mergeHead: existsSync(join(git(wt, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD")),
        files: git(wt, "ls-files").split("\n"),
      });
      return GREEN;
    },
    baseGate: async () => assert.fail("no base gate run was expected"),
    baseWentRed: () => {},
    timed: async (_issue: unknown, _phase: unknown, fn: () => unknown) => fn(),
    run: { ticket: () => {} },
    view: { claim: () => {} },
    host: { begin: () => {}, settle: async () => {} },
    requeuedAs: new Map(),
    results,
    reds: new Map(),
    landed: new Map(),
    reports: new Map(),
    notes: [],
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  } as unknown as PCtx);
  const attempt = async () => quietly(() => pipeline(issue));

  /** The real landing of the ticket's outcome, counting the landing gate runs. */
  const land = async (outcome: { head?: string }) => {
    let gateRuns = 0;
    const tracker = { ref: (id: string) => `#${id}`, close: () => {}, hold: () => {} };
    const ctx: LCtx = {
      project: { ...project, land: "merge" } as Project,
      tracker: tracker as unknown as LCtx["tracker"],
      base: "main",
      gateNames: "test",
      reports: new Map(),
      run: { ticket: () => {} },
      dryRun: false,
      opener: async (branch) => {
        const path = join(TMP, `wt${n++}`);
        git(root, "worktree", "add", "-q", "-b", branch, path, "main");
        return {
          worktreePath: path,
          exec: async (cmd) => {
            const r = spawnSync("sh", ["-c", cmd.replace(/^timeout -k \d+ \d+ /, "")], { cwd: path, encoding: "utf8" });
            return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
          },
          close: async () => git(root, "worktree", "remove", "--force", path),
        };
      },
      withdrawal: () => undefined,
      host: createHostGit(project, gitFingerprint(project)),
      gate: async () => {
        gateRuns++;
        return GREEN;
      },
      landed: new Map(),
    };
    const landed = await quietly(() => landOne(ctx, { issue: ID, branch: BRANCH, status: "green", commits: 1, repairs: 0, head: outcome.head! }));
    return { kind: landed.result.kind, gateRuns, root };
  };
  return { root, agents, gated, attempt, land };
};

const implementing = (file: string, text: string) => (wt: string) => void commit(wt, file, text);

test("a base that moved before the gates is merged into the branch first: the gate sees the tip, and landing it on an unmoved base runs no landing gate", async () => {
  const h = harness();
  h.agents.impl = (wt) => {
    commit(wt, "seven.txt", "seven\n");
    commit(h.root, "other.txt", "one\n", "another ticket landed");
  };
  const { result: o, lines } = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(h.gated.length, 1);
  const tip = git(h.root, "rev-parse", "main");
  assert.equal(git(h.root, "merge-base", "--is-ancestor", tip, h.gated[0].head) || "", "", "the gated head holds the base tip");
  assert.ok(h.gated[0].files.includes("other.txt") && h.gated[0].files.includes("seven.txt"));
  assert.equal(o.head, h.gated[0].head, "the green head is the merged tip the gates ran on");
  assert.ok(lines.includes(`#7: merged main into its branch before its gates (1 behind)`), lines.join("\n"));
  const landed = await h.land(o);
  assert.equal(landed.kind, "merged");
  assert.equal(landed.gateRuns, 0);
});

test("a base that moved after the gates still makes its landing gate", async () => {
  const h = harness();
  h.agents.impl = (wt) => {
    commit(wt, "seven.txt", "seven\n");
    commit(h.root, "other.txt", "one\n", "another ticket landed");
  };
  const { result: o } = await h.attempt();
  commit(h.root, "later.txt", "two\n", "a landing in between");
  const landed = await h.land(o);
  assert.equal(landed.kind, "merged");
  assert.equal(landed.gateRuns, 1);
});

test("a branch that already holds the tip gets no merge commit: its head is unchanged", async () => {
  const h = harness();
  h.agents.impl = implementing("seven.txt", "seven\n");
  const { result: o, lines } = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(h.gated[0].head, git(h.root, "rev-parse", BRANCH));
  assert.equal(git(h.root, "rev-list", "--merges", "--count", BRANCH), "0");
  assert.equal(git(h.root, "rev-list", "--count", `main..${BRANCH}`), "1");
  assert.ok(!lines.some((l) => l.includes("before its gates")), lines.join("\n"));
});

test("a merge that conflicts (the base moved after the conflict check) is aborted: no MERGE_HEAD, and the gates run on the pre-merge head", async () => {
  let before = "";
  const h = harness({
    beforeMerge: () => {
      // Lands over the lines the branch changed, after `conflictBefore` found none.
      if (!before) {
        before = "set";
        commit(h.root, "shared.txt", "one\n", "another ticket landed over the same line");
      }
    },
  });
  h.agents.impl = (wt) => {
    commit(wt, "shared.txt", "seven\n");
    commit(h.root, "other.txt", "one\n", "another ticket landed");
  };
  const { result: o, lines } = await h.attempt();
  const own = git(h.root, "rev-parse", BRANCH);
  assert.equal(o.status, "green");
  assert.equal(h.gated.length, 1);
  assert.equal(h.gated[0].mergeHead, false, "no merge left in progress");
  assert.equal(h.gated[0].head, own, "gated on the pre-merge head");
  assert.equal(git(h.root, "rev-list", "--merges", "--count", BRANCH), "0");
  assert.ok(lines.some((l) => l.startsWith("#7: could not merge main into its branch before its gates (conflicts in shared.txt)")), lines.join("\n"));
});

test("a setup that fails after the merge undoes it: the branch is gated as it stands", async () => {
  const h = harness({ setup: ["test ! -e other.txt"] });
  h.agents.impl = (wt) => {
    commit(wt, "seven.txt", "seven\n");
    commit(h.root, "other.txt", "one\n", "another ticket landed");
  };
  const own = () => git(h.root, "rev-parse", BRANCH);
  const { result: o, lines } = await h.attempt();
  assert.equal(o.status, "green");
  assert.equal(h.gated[0].head, own());
  assert.ok(!h.gated[0].files.includes("other.txt"));
  assert.ok(lines.some((l) => l.includes(`setup "test ! -e other.txt" exited 1) - undone, gated as it stands`)), lines.join("\n"));
});

test("a setup that passes runs after a merge that brought files, and the merge stands", async () => {
  const h = harness({ setup: ["test -e other.txt"] });
  h.agents.impl = (wt) => {
    commit(wt, "seven.txt", "seven\n");
    commit(h.root, "other.txt", "one\n", "another ticket landed");
  };
  const { result: o } = await h.attempt();
  assert.equal(o.status, "green");
  assert.ok(h.gated[0].files.includes("other.txt"));
});

test("the Touches overrun of a merged branch lists none of the files the merge brought", async () => {
  const h = harness();
  h.agents.impl = (wt) => {
    commit(wt, "seven.txt", "seven\n");
    commit(h.root, "brought.txt", "one\n", "another ticket landed");
  };
  const { result: o } = await h.attempt();
  assert.ok(h.gated[0].files.includes("brought.txt"));
  const head = o.head!;
  assert.deepEqual(touchesOverrun(h.root, "main", head, "Touches: seven.txt"), []);
  // The branch's own undeclared file still counts, so the empty list above is the merge's doing.
  assert.deepEqual(touchesOverrun(h.root, "main", head, "Touches: nothing-here.txt"), ["seven.txt"]);
});
