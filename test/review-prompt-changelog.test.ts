// With `changelog: true` the full review's prompt shows the implementer's changelog lines, as it shows the
// implementer's unmet line, so the reviewer keeps the ones that hold and corrects or adds the rest: full
// reviewers wrote that they could not see the lines and restated the whole set from the diff. A narrow
// review never sees them. The pipeline (`createPipeline`, src/burndown.ts) runs over a temp repo with a
// scripted agent, on the prompts `renderPrompts` really writes. No Docker, model, gh or network.
//
//   pnpm test:file test/review-prompt-changelog.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { implChangelogView, renderPrompts } = await import("../src/run.ts");
const { makeTracker } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Ctx = import("../src/burndown.ts").PipelineContext;
type Box = import("../src/burndown.ts").PipelineBox;
type GateRun = import("../src/gates.ts").GateRun;

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-review-changelog-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
};

const ID = "7";
const ISSUE = { id: ID, title: "seven", body: "" } as Parameters<ReturnType<typeof createPipeline>>[0];
const GREEN: GateRun = { gates: [{ name: "test", pass: true }], failures: [] };
const RED: GateRun = (() => {
  const failure = { name: "test", command: "run-tests", exitCode: 1, output: "FAIL: first" };
  return { gates: [{ name: "test", pass: false }], failure, failures: [failure] };
})();

const tag = (...lines: string[]) => lines.map((l) => `<changelog>${l}</changelog>`).join("\n");

/** What Sandcastle makes of a prompt file and the arguments a pass gave it: each `{{NAME}}` replaced in one pass. */
const filled = (promptFile: string, args: Record<string, string>) =>
  readFileSync(promptFile, "utf8").replace(/\{\{(\w+)\}\}/g, (whole, key: string) => args[key] ?? whole);

/** A project in a temp repo whose prompts are the kit's own, and a pipeline over it with every port faked. */
const harness = (opts: { changelog: boolean } = { changelog: true }) => {
  const root = join(TMP, `repo${n++}`);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Operator Example");
  git(root, "config", "user.email", "operator@example.com");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "shared.txt", "start\n");

  const project = {
    root, name: "fixture", label: "ready-for-agent", baseBranch: "main", gates: [{ name: "test", command: "run-tests" }],
    generated: [], setup: [], implement: {}, review: {}, repair: {}, tracker: fakeTracker(), changelog: opts.changelog,
  };
  const prompts = renderPrompts(project as unknown as Parameters<typeof renderPrompts>[0], makeTracker(project as unknown as Parameters<typeof makeTracker>[0]));

  const passes: { name: string; promptFile: string; args: Record<string, string> }[] = [];
  const agents: Record<string, (worktree: string) => string> = {};
  const gates: GateRun[] = [];
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
      run: async (o: { name?: string; promptFile?: string; promptArgs?: Record<string, string> }) => {
        const name = o.name ?? "";
        passes.push({ name, promptFile: o.promptFile ?? "", args: o.promptArgs ?? {} });
        const before = git(path, "rev-parse", "HEAD");
        const stdout = agents[name.split("-")[0]]?.(path) ?? "";
        const commits = git(path, "rev-list", `${before}..HEAD`).split("\n").filter(Boolean).map((sha) => ({ sha }));
        return { iterations: [], stdout, commits };
      },
      close: async () => {
        git(root, "worktree", "remove", "--force", path);
        return {};
      },
    } as unknown as Box;
  };
  const pipeline = createPipeline({
    project: project as unknown as Ctx["project"],
    tracker: { ref: (id: string) => `#${id}`, agentsWrite: true, promptArgs: () => ({}), reopenedSince: () => false } as unknown as Ctx["tracker"],
    runId: "2026-10-05T00:00:00.000Z",
    dryRun: false,
    repair: 1,
    testRedGate: false,
    prompts,
    overrides: new Map(),
    open,
    gate: async () => {
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
  const attempt = () => quietly(() => pipeline(ISSUE));
  return { prompts, passes, agents, gates, attempt };
};

/** An implementer that commits a file, saying `say`. */
const implementing = (say: string) => (wt: string) => {
  commit(wt, "a.txt", "a\n");
  return say;
};

test("the full review's prompt quotes the implementer's changelog lines, in order", async () => {
  const h = harness();
  const lines = ["Added: `sandcastle size` recommends the pool's limits.", "Fixed: a report no longer drops its last section."];
  h.agents.impl = implementing(tag(...lines));
  h.gates.push(GREEN);
  await h.attempt();
  const review = h.passes.find((p) => p.name === `review-${ID}`);
  assert.ok(review, "the full review ran");
  const prompt = filled(review.promptFile, review.args);
  const first = prompt.indexOf(`> ${lines[0]}`);
  const second = prompt.indexOf(`> ${lines[1]}`);
  assert.ok(first > 0 && second > first, `both lines are quoted in order:\n${prompt.slice(prompt.indexOf("Changelog lines"))}`);
  assert.doesNotMatch(prompt, /\{\{IMPL_CHANGELOG\}\}/);
});

test("the full review's prompt quotes nothing when the implementer gave no changelog line", async () => {
  const h = harness();
  h.agents.impl = implementing("Done. <changelog>...</changelog>");
  h.gates.push(GREEN);
  await h.attempt();
  const review = h.passes.find((p) => p.name === `review-${ID}`);
  assert.ok(review, "the full review ran");
  assert.equal(review.args.IMPL_CHANGELOG, "");
  const prompt = filled(review.promptFile, review.args);
  assert.doesNotMatch(prompt, /^> /m, "no quote");
  assert.doesNotMatch(prompt, /\{\{IMPL_CHANGELOG\}\}/);
  assert.match(prompt, /none quoted means it gave none/, "the reviewer is told that an empty quote is no line given");
});

test("the review after a repair is narrow and is not shown the implementer's lines", async () => {
  const h = harness();
  h.agents.impl = implementing(tag("Fixed: the implementer's own line."));
  h.agents.repair = (wt) => {
    commit(wt, "fix.txt", "fix\n");
    return "";
  };
  h.gates.push(RED, GREEN);
  await h.attempt();
  const reviews = h.passes.filter((p) => p.name === `review-${ID}`);
  assert.equal(reviews.length, 2, "a full review and the review after the repair");
  assert.match(reviews[0].args.IMPL_CHANGELOG, /the implementer's own line/);
  assert.ok(!("IMPL_CHANGELOG" in reviews[1].args), "the narrow prompt has no place for it");
  assert.doesNotMatch(filled(reviews[1].promptFile, reviews[1].args), /the implementer's own line/);
});

test("a project that did not ask for changelog lines has no placeholder in any prompt", () => {
  const h = harness({ changelog: false });
  for (const kind of ["implement", "review", "repair", "rereview", "remerge", "resolve"] as const) {
    assert.doesNotMatch(readFileSync(h.prompts[kind], "utf8"), /IMPL_CHANGELOG|Changelog lines/, kind);
  }
});

test("implChangelogView is empty with no lines, and quotes each line with some", () => {
  assert.equal(implChangelogView([]), "");
  const view = implChangelogView(["Added: one.", "Fixed: two."]);
  assert.match(view, /^> Added: one\.\n> Fixed: two\.\n\n$/);
});
