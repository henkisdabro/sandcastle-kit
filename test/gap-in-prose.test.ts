// A reviewer that names a known gap in prose - "left alone", "remains", "a gap", "not fixed" - and files it as
// neither a `<followup>` nor an `<unmet>` line loses it: nobody reads the message. The pipeline reads each
// review's final message for such a sentence, the run record keeps it as the ticket's `gap`, and the closing
// summary lists the ticket under Needs you with the sentence. A message with either tag, or whose words say
// nothing is left ("nothing remains"), flags nothing. A temp repo, scripted agent passes and run records; no
// Docker, model or network.
//
//   node --test test/gap-in-prose.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { quietly } from "./quiet.ts";

// sandbox.ts, pool.ts and peaks.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
for (const k of Object.keys(process.env)) if (/^GIT_(COMMITTER|AUTHOR)_/.test(k)) delete process.env[k];
const { createPipeline } = await import("../src/burndown.ts");
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
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

test("a review that leaves a known gap in prose and files none gives the pipeline's result the sentence", async () => {
  const said = await pipelineSaying("7", {
    impl: "Done.\n",
    review:
      "Reviewed the branch and fixed what I found.\n\n" +
      "One gap remains: it fails with SANDCASTLE_LINKS=1 because the link step reads the old name.\n" +
      "Two minor points I left alone, as they are cosmetic.\n<promise>COMPLETE</promise>\n",
  });
  assert.equal(said.result.gap, "One gap remains: it fails with SANDCASTLE_LINKS=1 because the link step reads the old name. Two minor points I left alone, as they are cosmetic.");
});

test("a review whose message wraps the sentence over lines still gives it whole", async () => {
  assert.equal(await gapOfReview("Fine.\n\nOne small inaccuracy\nremains in the README. It is minor.\n"), "One small inaccuracy remains in the README.");
});

test("a review that files its gap as a followup or an unmet line gives no gap", async () => {
  const prose = "One gap remains: the link step reads the old name.\n";
  assert.equal(await gapOfReview(`${prose}<followup>link step reads the old name - src/links.ts:12</followup>\n`), undefined);
  assert.equal(await gapOfReview(`${prose}<unmet>the link step still reads the old name</unmet>\n`), undefined);
});

test("a review that says nothing is left, or only mentions a tag, flags no gap", async () => {
  for (const clean of [
    "Reviewed; nothing remains to fix.",
    "There are no gaps between the ticket and the change.",
    "No remaining issues. The behaviour remains unchanged and the gates stay green.",
    "Nothing was left alone: every point I raised is fixed.",
    // The platform sentence the review prompt asks every reviewer for.
    "macOS remains unaffected: the change is TypeScript only. Linux behaviour remains untouched.",
    "Reviewed; all good.",
    // Each flagged as a gap by a first run.
    "The remaining tests pass.",
    "Every remaining criterion is met.",
    "The test covers the gap the ticket describes.",
  ]) assert.equal(await gapOfReview(`${clean}\n`), undefined, clean);
  // The same words that do name a gap still do.
  assert.equal(await gapOfReview("The remaining issue is that the link step reads the old name.\n"), "The remaining issue is that the link step reads the old name.");
  assert.equal(await gapOfReview("A gap is left: the README still names AGE.\n"), "A gap is left: the README still names AGE.");
  // Words inside a fence or a tag are no prose of the reviewer's.
  assert.equal(await gapOfReview("Fine.\n\n```\na gap remains in this quoted log\n```\n<ungated>a gap remains: check the page by hand</ungated>\n"), undefined);
});

/** A project whose run record is `record`, with a fake `gh` that lists no issues. */
const summary = async (record: object) => {
  const root = repo();
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ startedAt: "2026-10-05T06:00:00Z", finishedAt: "2026-10-05T07:00:00Z", pid: 1, ...record }));
  const bin = mkdtempSync(join(TMP, "bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\n[ \"$1 $2\" = \"issue list\" ] && printf '%s\\n' '[]'\nexit 0\n");
  chmodSync(join(bin, "gh"), 0o755);
  const project = { root, baseBranch: "main", tracker: fakeTracker(), gates: [] } as unknown as Project;
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    return render(await gather(project, () => undefined), true);
  } finally {
    process.env.PATH = path;
  }
};
const needsYou = (out: string) => out.slice(out.indexOf("## Needs you"), out.indexOf("##", out.indexOf("## Needs you") + 3));

test("the closing summary lists a merged ticket with a gap under Needs you with the sentence, and one without does not", async () => {
  const out = await summary({
    tickets: {
      "7": { state: "merged", title: "seven", gap: "One gap remains: it fails with SANDCASTLE_LINKS=1." },
      "8": { state: "merged", title: "eight" },
    },
  });
  assert.deepEqual(
    needsYou(out).split("\n").filter((l) => l.startsWith("- ")),
    ["- #7 seven - merged - the reviewer named a gap it did not file: One gap remains: it fails with SANDCASTLE_LINKS=1."],
  );
  assert.match(out, / - 1 need you - /);
  assert.match(out, /Read the gap the reviewer named in prose on #7/);
});
