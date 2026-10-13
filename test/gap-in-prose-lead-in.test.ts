// The gap-in-prose detector (`gapOf`) quotes a reviewer's gap sentence. A gap sentence that is a lead-in -
// it names nothing itself (no path, identifier, code span, quote, digit or proper name) and ends its
// thought ("One edge case I left alone.") - brings the sentences after it in its unit, because what it
// leads into is what follows. A short sentence that names its subject stays alone. A temp repo and scripted agent
// passes; no Docker, model or network.
//
//   pnpm test:file test/gap-in-prose-lead-in.test.ts


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
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type FollowUp = import("../src/burndown.ts").FollowUp;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-followup-"));
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
const repo = () => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n", "start");
  return root;
};

/** One ticket's pipeline over a temp repo, its agent passes answering with `say[kind]`, every gate green. */
const pipelineSaying = async (id: string, say: Record<string, string>) => {
  const root = repo();
  const prompts = Object.fromEntries(
    ["implement", "review", "repair", "rereview", "remerge", "resolve"].map((kind) => {
      write(root, `.sandcastle/.run/${kind}.md`, "{{ISSUE_NUMBER}}\n");
      return [kind, join(root, `.sandcastle/.run/${kind}.md`)];
    }),
  ) as Ctx["prompts"];
  const open = async (branch: string): Promise<Box> => {
    const path = join(TMP, `wt${n++}`);
    git(root, "worktree", "add", "-q", "-b", branch, path, "main");
    return {
      worktreePath: path,
      exec: async (cmd: string) => {
        if (!cmd.startsWith("git ")) return { exitCode: 127, stdout: "", stderr: "not in the fake sandbox" };
        const r = spawnSync("sh", ["-c", cmd], { cwd: path, encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      run: async (opts: { name?: string }) => {
        const kind = (opts.name ?? "").split("-")[0];
        const before = git(path, "rev-parse", "HEAD");
        if (kind === "impl") commit(path, "work.txt", "work\n");
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout: say[kind] ?? "", commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };
  const followUps: FollowUp[] = [];
  const pipeline = createPipeline({
    project: { root, name: "fixture", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }], generated: [], setup: [], implement: {}, review: {}, repair: {} } as unknown as Ctx["project"],
    tracker: { ref: (t: string) => `#${t}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-05T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => ({ gates: [{ name: "test", pass: true }], failures: [] }),
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
    followUps,
    took: new Map(),
    keptWorktrees: [],
    tampered: new Map(),
  });
  const { result } = await quietly(() => pipeline({ id, title: "a ticket", body: "", comments: [] }));
  assert.equal(result.status, "green");
  return { result, followUps };
};


const gapOfReview = async (review: string) => (await pipelineSaying("7", { impl: "Done.\n", review })).result.gap;

test("a lead-in gap sentence is quoted with the sentences after it in its bullet", async () => {
  assert.equal(
    await gapOfReview("Fine.\n\n- One edge case I left alone. A branch with no commits is still reported green. The report then lists it as landed.\n"),
    "One edge case I left alone. A branch with no commits is still reported green. The report then lists it as landed.",
  );
});

test("a lead-in in a wrapped paragraph brings the rest of the paragraph and no later one", async () => {
  assert.equal(
    await gapOfReview("Fine.\n\nTwo minor points I left alone.\nThe first is the order of the flags. The second is the spacing.\n\nThe gates are green.\n"),
    "Two minor points I left alone. The first is the order of the flags. The second is the spacing.",
  );
});

test("a lead-in that says I does not count the pronoun as a name", async () => {
  assert.equal(await gapOfReview("One gap I did not close. It is the retry path. The retry never backs off.\n"), "One gap I did not close. It is the retry path. The retry never backs off.");
});

test("a gap sentence that names its subject stays alone, and so does a lead-in with nothing after it", async () => {
  assert.equal(await gapOfReview("One small inaccuracy remains in the README. It is minor. It is cosmetic.\n"), "One small inaccuracy remains in the README.");
  assert.equal(await gapOfReview("One gap remains in `src/links.ts`. The link step reads the old name.\n"), "One gap remains in `src/links.ts`.");
  assert.equal(await gapOfReview("One gap remains in step 3. The link step reads the old name.\n"), "One gap remains in step 3.");
  assert.equal(await gapOfReview("Fine.\n\n- One edge case I left alone.\n- The gates are green.\n"), "One edge case I left alone.");
});
