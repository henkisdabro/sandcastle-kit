// The closing summary's Needs you section keeps what a person must act on apart from what is only left for
// triage: the follow-ups the run filed and the issues opened during it go under a `### To triage` sub-heading,
// after the run's own items, so each headline count (`need you`, `to triage`) matches the bullets of its group.
// A Markdown-files tracker; no gh, Docker or network.
//
//   pnpm test:file test/report-to-triage-heading.test.ts

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

const summary = async (record: object, plain = true, opened: { id: string; title: string }[] = []) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ startedAt: "2026-10-05T06:00:00Z", finishedAt: "2026-10-05T07:00:00Z", stage: "report", exitCode: 0, pid: 1, tickets: { "1": { state: "merged", title: "a", ungated: "open the page" } }, ...record }),
  );
  const project = { root, baseBranch: "main", tracker: fakeTracker({ kind: "files" }), gates: [] } as any;
  // The issues opened during the run come from the tracker, which a test has no `gh` for: set them on the facts.
  return render({ ...(await gather(project, () => undefined)), filed: opened }, plain);
};

// The lines of the Needs you section, between its heading and the next `## ` one.
const needsYou = (text: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^## (🙋 )?Needs you/.test(l));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).filter(Boolean);
};

const FILED = { title: "a stale fixture", from: "1", phase: "implement", id: "91" };
const FAILED = { title: "the clock drifts", from: "1", phase: "review", failed: "gh: HTTP 502" };

test("filed follow-ups go under a To triage heading after the run's own items, and the headline counts match", async () => {
  const out = await summary({ followUps: [FILED, FAILED] });
  assert.match(out, / - 2 need you - 0 need fixing - 1 to triage - /);
  const lines = needsYou(out);
  const at = lines.indexOf("### To triage");
  assert.ok(at > 0, "a To triage sub-heading");
  const before = lines.slice(0, at).filter((l) => l.startsWith("- "));
  const after = lines.slice(at + 1).filter((l) => l.startsWith("- "));
  assert.equal(before.length, 2, "the check by hand and the file-it-by-hand line need you");
  assert.match(before[0], /merged - check by hand/);
  assert.match(before[1], /file it by hand$/);
  assert.equal(after.length, 1);
  assert.match(after[0], /^- #91 a stale fixture - filed for triage from #1 \(implement\)/);
});

test("issues opened during the run are listed under To triage too", async () => {
  const out = await summary({ followUps: [FILED] }, true, [{ id: "92", title: "opened by an agent" }]);
  const lines = needsYou(out);
  const after = lines.slice(lines.indexOf("### To triage") + 1).filter((l) => l.startsWith("- "));
  assert.equal(after.length, 2);
  assert.match(after[1], /^- #92 opened by an agent - opened during this run/);
});

test("with nothing to triage, there is no To triage heading", async () => {
  const out = await summary({ followUps: [FAILED] });
  assert.doesNotMatch(out, /To triage/);
});

test("a dry run's unfiled follow-ups are listed under To triage", async () => {
  const out = await summary({ dryRun: true, followUps: [{ title: "the clock drifts", from: "1", phase: "review" }] });
  const lines = needsYou(out);
  const at = lines.indexOf("### To triage");
  assert.ok(at >= 0);
  assert.match(lines[at + 1], /a real run files it for triage/);
});

test("the heading is the same with colour and emoji", async () => {
  const out = await summary({ followUps: [FILED] }, false);
  assert.ok(needsYou(out).includes("### To triage"));
});
