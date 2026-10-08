// A branch an earlier run held for a person is said to be so beside the branch in the closing
// summary, with the way to resolve it; a standing branch with no such outcome reads as before.
//
//   node --test test/report-earlier-held.test.ts

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

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "97.5M in / 725k out",
  verify: { green: true, line: "ruff=pass pytest=pass" },
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

test("a branch held in an earlier run says so with the reason, and the next step merges it by hand or drops it", () => {
  const out = render(facts({ standing: ["agent/issue-7"], earlierHeld: { "agent/issue-7": "needs a human merge" } }));
  assert.match(body(out, "## 📤 Local state"), /Agent branches with unmerged work: agent\/issue-7 \(held for a human merge in an earlier run: needs a human merge\)/);
  const next = body(out, "## 👉 Next step");
  assert.match(next, /git log -p main\.\.agent\/issue-7/);
  assert.match(next, /git merge --no-ff agent\/issue-7/);
  assert.match(next, /git branch -D agent\/issue-7/);
  assert.doesNotMatch(next, /sandcastle land/);
  assert.match(next, /`sandcastle clean` once the branches above are resolved/);
});

test("only the earlier-held branch among several standing ones is annotated", () => {
  const out = render(facts({ standing: ["agent/issue-7", "agent/issue-8"], earlierHeld: { "agent/issue-8": "needs a human merge" } }));
  assert.match(body(out, "## 📤 Local state"), /agent\/issue-7, agent\/issue-8 \(held for a human merge in an earlier run: needs a human merge\)/);
});

test("a standing branch with no recorded outcome prints as before", () => {
  const out = render(facts({ standing: ["agent/issue-7"] }));
  const state = body(out, "## 📤 Local state");
  assert.match(state, /Agent branches with unmerged work: agent\/issue-7$/m);
  assert.doesNotMatch(state, /earlier run/);
  const next = body(out, "## 👉 Next step");
  assert.doesNotMatch(next, /git merge --no-ff|git branch -D/);
  assert.match(next, /`sandcastle clean` once the branches above are resolved/);
});

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("gather: only a standing branch whose held outcome is from an earlier run is marked", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-earlier-held-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  // 7: held by an earlier run; 8: held by this run; 9: no outcome at all.
  for (const id of ["7", "8", "9"]) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    writeFileSync(join(root, `work-${id}.txt`), "work\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", `work ${id}`);
  }
  git(root, "checkout", "-q", "main");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const started = "2026-10-02T08:00:00.000Z";
  writeFileSync(
    join(root, ".sandcastle/logs/outcomes.json"),
    JSON.stringify({
      "7": { run: "2026-10-01T08:00:00.000Z", kind: "held", text: "needs a human merge" },
      "8": { run: started, kind: "held", text: "needs a human merge" },
    }),
  );
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: "2026-10-02T09:00:00.000Z", exitCode: 0, stage: "report", tickets: {} }));
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const facts = await gather(project, () => undefined);
  assert.deepEqual(facts.earlierHeld, { "agent/issue-7": "needs a human merge" });
  const state = body(render(facts), "## 📤 Local state");
  assert.match(state, /agent\/issue-7 \(held for a human merge in an earlier run: needs a human merge\), agent\/issue-8, agent\/issue-9$/m);
});
