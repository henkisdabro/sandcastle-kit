// An earlier run's held branch whose head record left a criterion unmet is merged by hand as "part of"
// its ticket, never `closes`: merging and pushing a `closes` subject would close unfinished work.
//
//   pnpm test:file test/report-earlier-held-unmet.test.ts

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
type Project = import("../src/config.ts").Project;

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const nextStep = (text: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("## 👉 Next step"));
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
};

test("an earlier run's held branch with an unmet criterion gets a part-of merge command, and one without keeps closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-earlier-unmet-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "base");
  for (const id of ["7", "8"]) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`, "main");
    writeFileSync(join(root, `work-${id}.txt`), "work\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", `work ${id}`);
  }
  git(root, "checkout", "-q", "main");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const earlierRun = "2026-10-01T08:00:00.000Z";
  const started = "2026-10-02T08:00:00.000Z";
  writeFileSync(
    join(root, ".sandcastle/logs/outcomes.json"),
    JSON.stringify({
      "7": { run: earlierRun, kind: "held", text: "needs a human merge" },
      "8": { run: earlierRun, kind: "held", text: "needs a human merge" },
    }),
  );
  // 7 left a criterion undone; 8 has no head record at all.
  writeFileSync(join(root, ".sandcastle/logs/heads.json"), JSON.stringify({ "7": { branch: "agent/issue-7", unmet: "the retry limit is not configurable", run: earlierRun, at: earlierRun } }));
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: started, finishedAt: "2026-10-02T09:00:00.000Z", exitCode: 0, stage: "report", tickets: {} }));
  const project = { root, name: "t", baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  const next = nextStep(render(await gather(project, () => undefined)));
  assert.match(next, /git merge --no-ff -m "Merge agent\/issue-7 \(part of #7\)" agent\/issue-7/);
  assert.doesNotMatch(next, /\(closes #7\)/);
  assert.match(next, /git merge --no-ff -m "Merge agent\/issue-8 \(closes #8\)" agent\/issue-8/);
});
