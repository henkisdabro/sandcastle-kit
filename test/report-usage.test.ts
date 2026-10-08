// The closing summary gives the plan's last reading under its Settings line (`Plan usage at the end:
// 5h 21%, week 97%`), and nothing when the run had none: an API-key run, a run on no Claude model, or a
// run that no agent reported to. Facts only, no Docker and no network.
//
//   pnpm test:file test/report-usage.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PlanUsage, RunSettings } from "../mod/hooks/run-record.ts";
import type { Project } from "../src/config.ts";
import { type Facts, render } from "../src/report.ts";

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: { green: true, line: "ok" },
  gateCount: 2,
  tickets: { "7": { state: "merged", title: "a" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const settings: RunSettings = { autonomy: 0, turn: 1, cap: 1, crossReview: false, usageGuard: false };
const reading: PlanUsage = {
  provider: "claude",
  windows: { fiveHour: { percent: 21, resetsAt: 1791195000 }, week: { percent: 97, resetsAt: 1791324000 } },
  at: 1791190000,
};
const lines = (f: Facts) => render(f, true).split("\n");

test("the last reading stands under the Settings line", () => {
  const out = lines(facts({ settings, usage: reading }));
  const at = out.findIndex((l) => l.startsWith("Settings:"));
  assert.ok(at >= 0);
  assert.equal(out[at + 1], "Plan usage at the end: 5h 21%, week 97%");
});

test("a run still going says so far, not at the end", () => {
  const out = lines(facts({ settings, usage: reading, live: true }));
  assert.ok(out.includes("Plan usage so far: 5h 21%, week 97%"), out.join("\n"));
});

test("a run with no reading says nothing of the plan: waiting, an API-key run, or an older record", () => {
  for (const f of [
    facts({ settings, usage: { provider: "claude" } }),
    facts({ settings: { ...settings, apiKey: true } }),
    facts({ settings }),
    facts({ usage: { provider: "claude" } }),
  ]) assert.equal(lines(f).some((l) => l.startsWith("Plan usage")), false, lines(f).join("\n"));
});

test("a record with a reading and no settings group still gives the line", () => {
  assert.ok(lines(facts({ usage: reading })).includes("Plan usage at the end: 5h 21%, week 97%"));
});

test("gathered from the run record on disk, the reading is the record's usage, and a malformed one is none", async () => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const { gather } = await import("../src/report.ts");
  const { fakeTracker } = await import("./fixtures.ts");
  const root = mkdtempSync(join(tmpdir(), "sandcastle-report-usage-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "t"], { cwd: root });
  mkdirSync(join(root, ".scratch/shop/issues"), { recursive: true });
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const record = (usage: unknown) =>
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
  const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
  record(reading);
  assert.ok(render(await gather(project), true).split("\n").includes("Plan usage at the end: 5h 21%, week 97%"));
  for (const junk of [{ provider: "claude", windows: "lots" }, "claude", 7, { provider: "codex", windows: "lots" }]) {
    record(junk);
    assert.equal(/plan usage/i.test(render(await gather(project), true)), false, JSON.stringify(junk));
  }
  // An older kit's one-object form holding Codex's reading is Codex's line, never Claude's.
  record({ provider: "codex", windows: reading.windows, at: 1 });
  const out = render(await gather(project), true).split("\n");
  assert.ok(out.includes("Codex plan usage at the end: 5h 21%, week 97%"), out.join("\n"));
  assert.equal(out.some((l) => l.startsWith("Plan usage")), false, out.join("\n"));
});
