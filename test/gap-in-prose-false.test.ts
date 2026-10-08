// The gap-in-prose detector (`gapOf`) reads a reviewer's final message for a gap it named and filed
// nowhere. These are the sentences it took for a gap and was wrong: a word inside inline code, a
// heading, "remaining ..., which is correct", "found a gap ... and fixed it", a deliberate omission
// the ticket asked for, a number before "remaining" - and a gap whose sentence opens with "That" and
// reads only with the sentence before it. A temp repo and scripted agent passes; no Docker, model or network.
//
//   pnpm test:file test/gap-in-prose-false.test.ts

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
type Project = import("../src/config.ts").Project;

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

test("a gap word inside inline code is no gap", async () => {
  assert.equal(await gapOfReview("Added the case to `gap-in-prose` and `test/gap-in-prose.test.ts`.\n"), undefined);
});

test("a gap word outside inline code on the same line is still a gap", async () => {
  assert.equal(await gapOfReview("A gap remains in `src/links.ts`.\n"), "A gap remains in `src/links.ts`.");
});

test("a remaining mention the reviewer calls correct is no gap", async () => {
  assert.equal(await gapOfReview("The only remaining mention is in past `CHANGELOG.md` entries, which is correct.\n"), undefined);
  assert.equal(await gapOfReview("The remaining mentions are in the archive, which are expected.\n"), undefined);
});

test("a gap the reviewer found and fixed is no gap, and a bold heading line is no sentence", async () => {
  const review =
    "**Checked and left as is**\n" +
    "I found one gap in the work (the README named the old flag) and fixed both in commit c1282d6.\n";
  assert.equal(await gapOfReview(review), undefined);
  // The heading does not join the paragraph under it.
  assert.equal(await gapOfReview("## What remains\nThe link step reads the old name.\n"), undefined);
  assert.equal(await gapOfReview("**Checked and left as is**\nOne gap remains: the README names AGE.\n"), "One gap remains: the README names AGE.");
});

test("an omission the ticket asked for, and a counted remaining set that matches, are no gaps", async () => {
  assert.equal(await gapOfReview("The legacy parser was left alone, as the ticket asked.\n"), undefined);
  assert.equal(await gapOfReview("All 36 remaining call sites match the new signature.\n"), undefined);
  // A leave-alone the ticket did not ask for still is one.
  assert.equal(await gapOfReview("Two minor points I left alone, as they are cosmetic.\n"), "Two minor points I left alone, as they are cosmetic.");
});

test("a gap sentence that opens with That is quoted with the sentences before it in its paragraph", async () => {
  const review =
    "Which check would have caught a wrong pointer: `test_skill_claims.py` checks for dead paths only under `.claude/`, not in `scripts/`. " +
    "A dangling citation in this docstring would only show up in the ticket's grep or a manual read of the GLOSSARY heading. " +
    "That is a coverage gap, not something this branch caused, so I've left it there.\n";
  assert.equal(await gapOfReview(`Fine.\n\n> ${review}`), review.trim());
});

test("a gap sentence that does not open with an anaphor is quoted alone", async () => {
  assert.equal(await gapOfReview("The link step was checked. One gap remains: the README names AGE.\n"), "One gap remains: the README names AGE.");
});
