// The closing summary with the run record's `usage` holding a list: Claude's entry gives the `Plan usage at the
// end:` line it always gave, and Codex's reading, when cross-review has one, adds a `Codex plan usage at the end:`
// line beside it. With no Codex reading the summary is unchanged. Facts only: a temp repository, no Docker, no network.
//
//   pnpm test:file test/report-usage-codex.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PlanUsage, RunSettings } from "../mod/hooks/run-record.ts";
import type { Project } from "../src/config.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");

const settings: RunSettings = { autonomy: 0, turn: 1, cap: 1, crossReview: true, usageGuard: false };
const claude: PlanUsage = {
  provider: "claude",
  windows: { fiveHour: { percent: 21, resetsAt: 1791195000 }, week: { percent: 97, resetsAt: 1791324000 } },
  at: 1791190000,
};
const codex: PlanUsage = {
  provider: "codex",
  windows: { fiveHour: { percent: 100, resetsAt: 1791188474 }, week: { percent: 16, resetsAt: 1791713039 } },
  at: 1791190000,
};

const root = mkdtempSync(join(tmpdir(), "sandcastle-report-usage-codex-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "t"], { cwd: root });
mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
const summary = async (usage: unknown) => {
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({
      pid: 2 ** 22 + 1,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T01:00:00Z",
      exitCode: 0,
      stage: "report",
      settings,
      usage,
      tickets: { "1": { state: "merged", title: "good" } },
    }),
  );
  return render(await gather(project), true);
};

test("a cross-review run's Codex reading gets a line beside Claude's, which stands as it was", async () => {
  const out = (await summary([claude, codex])).split("\n");
  const at = out.indexOf("Plan usage at the end: 5h 21%, week 97%");
  assert.notEqual(at, -1, out.join("\n"));
  assert.equal(out[at + 1], "Codex plan usage at the end: 5h 100%, week 16%");
});

test("a record with no Codex reading has no Codex line, and the summary is as it was", async () => {
  for (const usage of [[claude], [claude, { provider: "codex" }], claude]) {
    const out = (await summary(usage)).split("\n");
    assert.ok(out.includes("Plan usage at the end: 5h 21%, week 97%"), JSON.stringify(usage));
    assert.equal(out.some((l) => /codex/i.test(l) && l.includes("usage")), false, JSON.stringify(usage));
  }
});

test("Codex's reading stands alone when Claude has none, and no reading at all says nothing of the plan", async () => {
  for (const usage of [[codex], [{ provider: "claude" }, codex]]) {
    const out = (await summary(usage)).split("\n");
    assert.ok(out.includes("Codex plan usage at the end: 5h 100%, week 16%"), JSON.stringify(usage));
    assert.equal(out.some((l) => l.startsWith("Plan usage")), false, JSON.stringify(usage));
  }
  assert.equal((await summary([{ provider: "claude" }, { provider: "codex" }])).includes("lan usage"), false);
});
