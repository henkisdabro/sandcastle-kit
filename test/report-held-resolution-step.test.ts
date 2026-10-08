// A branch held for its conflict resolution's stray edits is checked and landed with `sandcastle land`
// (which gates the merge), in this run's summary and in later runs'; a landing hold (protected path, large
// file, unreviewed repair) is still merged by hand.
//
//   pnpm test:file test/report-held-resolution-step.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Facts = import("../src/report.ts").Facts;
type Project = import("../src/config.ts").Project;

const NOTE = "conflict resolution changed src/a.ts, which merged cleanly - check no other ticket's lines were lost";
const RESOLUTION = `needs a human: ${NOTE}`;

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
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

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("gather lists a held resolution's ticket, and neither a landing hold's nor a hand-back's", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-held-resolution-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  for (const id of ["7", "8", "9"]) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    writeFileSync(join(root, `work-${id}.txt`), "work\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", `work ${id}`);
  }
  git(root, "checkout", "-q", "main");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const started = "2026-10-02T08:00:00.000Z";
  const earlier = "2026-10-01T08:00:00.000Z";
  writeFileSync(
    join(root, ".sandcastle/logs/outcomes.json"),
    JSON.stringify({
      "7": { run: earlier, kind: "held", text: RESOLUTION },
      "8": { run: earlier, kind: "held", text: "needs a human merge" },
      "9": { run: earlier, kind: "held", text: "needs a human: handed back" },
    }),
  );
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: "2026-10-02T09:00:00.000Z", exitCode: 0, stage: "report", tickets: {} }));
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const gathered = await gather(project, () => undefined);
  assert.deepEqual(gathered.heldResolutions, ["7"]);
  const out = render(gathered);
  const state = section(out, "## 📤 Local state");
  assert.match(state, new RegExp(`agent/issue-7 \\(its conflict resolution was held in an earlier run: ${NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  assert.match(state, /agent\/issue-8 \(held for a human merge in an earlier run: needs a human merge\)/);
});

test("an earlier held resolution is checked and landed with sandcastle land, not merged by hand", () => {
  const out = render(facts({ standing: ["agent/issue-7"], earlierHeld: { "agent/issue-7": RESOLUTION }, heldResolutions: ["7"] }));
  const state = section(out, "## 📤 Local state");
  assert.match(state, new RegExp(`agent/issue-7 \\(its conflict resolution was held in an earlier run: conflict resolution changed src/a\\.ts`));
  assert.doesNotMatch(state, /held for a human merge|needs a human: /);
  const next = section(out, "## 👉 Next step");
  assert.match(next, /Check the resolution on agent\/issue-7, held in an earlier run: `git log -p main\.\.agent\/issue-7`; if no other ticket's lines were lost, `sandcastle land 7` lands it with the gates; if some were, fix the branch first, or `sandcastle requeue 7 --note "..."`\./);
  assert.doesNotMatch(next, /git merge --no-ff|held for a human merge/);
});

test("several earlier held resolutions name <branch> and <n>", () => {
  const out = render(facts({ standing: ["agent/issue-7", "agent/issue-8"], earlierHeld: { "agent/issue-7": RESOLUTION, "agent/issue-8": RESOLUTION }, heldResolutions: ["7", "8"] }));
  const next = section(out, "## 👉 Next step");
  assert.match(next, /Check the resolution on agent\/issue-7, agent\/issue-8, held in an earlier run: `git log -p main\.\.<branch>`; .*`sandcastle land <n>` lands each with the gates/);
});

test("an earlier landing hold prints as before, beside a held resolution", () => {
  const out = render(facts({ standing: ["agent/issue-7", "agent/issue-8"], earlierHeld: { "agent/issue-7": RESOLUTION, "agent/issue-8": "needs a human merge" }, heldResolutions: ["7"] }));
  assert.match(section(out, "## 📤 Local state"), /agent\/issue-8 \(held for a human merge in an earlier run: needs a human merge\)/);
  const next = section(out, "## 👉 Next step");
  assert.match(next, /Resolve agent\/issue-8, held for a human merge in an earlier run: review it with `git log -p main\.\.agent\/issue-8` and merge by hand with `git merge --no-ff agent\/issue-8`, or drop it with `git branch -D agent\/issue-8`\./);
  assert.match(next, /`sandcastle land 7`/);
  assert.doesNotMatch(next, /git merge --no-ff agent\/issue-7/);
});

test("this run's held resolution lists land:, and a protected-path hold beside it still lists merge:", () => {
  const out = render(
    facts({
      standing: ["agent/issue-1", "agent/issue-2"],
      changed: { "1": 2, "2": 1 },
      heldResolutions: ["1"],
      tickets: {
        "1": { state: "held", title: "stray", note: NOTE },
        "2": { state: "held", title: "protected", note: "changes how the repo executes", files: [".githooks/pre-push"] },
      },
    }),
    true,
  );
  const needs = section(out, "## Needs you");
  assert.match(needs, /- #1 stray - .*\n {2}review: git log -p main\.\.agent\/issue-1 {3}land: sandcastle land 1\n/);
  assert.doesNotMatch(needs, /git merge --no-ff agent\/issue-1\b/);
  assert.match(needs, /- #2 protected - .*\n {2}review: git log -p main\.\.agent\/issue-2 {3}merge: git merge --no-ff agent\/issue-2\n/);
  const next = section(out, "## Next step");
  assert.match(next, /Review and merge the 1 held branch\(es\)/);
  assert.match(next, /Check and land the 1 held conflict resolution\(s\)/);
});
