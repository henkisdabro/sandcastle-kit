// The closing summary's header counts what its sections ask of a person. A follow-up whose filing failed
// is a "file it by hand" line under Needs you, so it counts towards `need you`; a dry run's follow-ups
// (and any a run left unfiled) are what a real run would leave for triage, so they count towards `to
// triage`. Each test starts from a run record on disk, read by `gather` as `sandcastle report` does.
// No gh, Docker or network: a Markdown-files tracker.
//
//   pnpm exec tsx --test test/report-follow-up-counts.test.ts

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

/** The summary of a record whose run started 2026-10-05T06:00 and ended an hour later, one ticket merged. */
const summary = async (record: object) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ startedAt: "2026-10-05T06:00:00Z", finishedAt: "2026-10-05T07:00:00Z", stage: "report", exitCode: 0, pid: 1, tickets: { "1": { state: "merged", title: "a" } }, ...record }),
  );
  const project = { root, baseBranch: "main", tracker: fakeTracker({ kind: "files" }), gates: [] } as any;
  return render(await gather(project, () => undefined), true);
};

// The lines of one section, between its heading and the next.
const section = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next);
};

const FAILED = { title: "the clock drifts", from: "1", phase: "review", failed: "gh: HTTP 502" };
const FILED = { title: "a stale fixture", from: "1", phase: "implement", id: "91" };

test("a follow-up whose filing failed counts towards need you, as the file-it-by-hand line says", async () => {
  const out = await summary({ followUps: [FAILED] });
  const lines = section(out, "## Needs you").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^- the clock drifts - from #1 \(review\): filing it for triage failed \(gh: HTTP 502\) - file it by hand$/);
  assert.match(out, / - 1 need you - /);
  assert.doesNotMatch(out, /to triage/, "a person files it by hand: it is not left for triage");
});

test("the header's need you and to triage split the follow-up lines: filed ones are to triage, failed ones need you", async () => {
  const out = await summary({ followUps: [FILED, FAILED, { ...FAILED, title: "a second one" }] });
  assert.match(out, / - 2 need you - 0 need fixing - 1 to triage - /);
  const lines = section(out, "## Needs you").filter((l) => l.startsWith("- "));
  assert.equal(lines.filter((l) => /file it by hand/.test(l)).length, 2);
  assert.equal(lines.filter((l) => /filed for triage from/.test(l)).length, 1);
});

test("a dry run's unfiled follow-ups count towards to triage, and not towards need you", async () => {
  const out = await summary({
    dryRun: true,
    followUps: [
      { title: "the clock drifts", from: "1", phase: "review" },
      { title: "a stale fixture", from: "1", phase: "implement" },
    ],
  });
  assert.match(out, / - 0 need you - 0 need fixing - 2 to triage - /);
  assert.equal(section(out, "## Needs you").filter((l) => /a real run files it for triage/.test(l)).length, 2);
});

test("a record with no follow-ups has neither count", async () => {
  const out = await summary({});
  assert.match(out, / - 0 need you - 0 need fixing - 0 not started/);
  assert.doesNotMatch(out, /to triage/);
});
