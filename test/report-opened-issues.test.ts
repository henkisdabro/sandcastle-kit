// The closing summary's follow-up issues: those opened during the run, not an agent's (agents
// share the person's `gh` token, so the author cannot say), and not any a person opens after the
// run has finished. The header counts them on their own, as "to triage". A fake `gh` first on
// PATH (plain sh, the same on macOS and Linux) answers from a fixture; no network.
//
//   pnpm exec tsx --test test/report-opened-issues.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Facts = Parameters<typeof render>[0];

const dir = mkdtempSync(join(tmpdir(), "sandcastle-gh-"));
const gh = join(dir, "gh");
writeFileSync(gh, `#!/bin/sh\n[ "$1 $2" = "issue list" ] && printf '%s\\n' "$FAKE_GH_ISSUES"\nexit 0\n`);
chmodSync(gh, 0o755);
process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;

const ISSUES = [
  { number: 40, title: "before the run", createdAt: "2026-09-30T05:59:00Z" },
  { number: 41, title: "during the run", createdAt: "2026-09-30T06:30:00Z" },
  { number: 42, title: "after the run", createdAt: "2026-09-30T07:30:00Z" },
];

const project = (record: object) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ startedAt: "2026-09-30T06:00:00Z", pid: 1, tickets: { "1": { state: "merged", title: "a" } }, ...record }),
  );
  process.env.FAKE_GH_ISSUES = JSON.stringify(ISSUES);
  return { root, baseBranch: "main", tracker: fakeTracker(), gates: [] } as any;
};

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:00:00.000Z",
  finished: "2026-09-30T07:00:00.000Z",
  live: false,
  dryRun: false,
  gateCount: 0,
  tickets: { "1": { state: "merged", title: "a" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

test("gather: an issue opened after the run finished is not listed", async () => {
  const f = await gather(project({ finishedAt: "2026-09-30T07:00:00Z" }), () => undefined);
  assert.deepEqual(f.filed, [{ id: "41", title: "during the run" }]);
});

test("gather: a run with no end written yet keeps the window open", async () => {
  const f = await gather(project({}), () => undefined);
  assert.deepEqual(f.filed?.map((i) => i.id), ["41", "42"]);
});

test("render: the header counts issues to triage on their own, and the line does not say an agent filed them", () => {
  const out = render(facts({ filed: [{ id: "41", title: "during the run" }, { id: "43", title: "mid-run" }] }));
  assert.match(out, / - 0 need you - 0 need fixing - 2 to triage - 0 not started/);
  assert.match(out, /- #41 during the run - opened during this run: triage it, then queue or close it/);
  assert.doesNotMatch(out, /filed by an agent/);
});

test("render: with none opened, the header has no to-triage count", () => {
  assert.doesNotMatch(render(facts()), /to triage/);
});
