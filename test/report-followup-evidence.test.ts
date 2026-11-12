// A follow-up the kit did not file is listed in the closing summary to file by hand, and its evidence and uncut title go
// with it: a person or agent filing it no longer greps the agents' logs for `<followup>` tags. The summary is read from a
// run record on disk, as `sandcastle report` does; the record is written by the follow-up book from the agents' own tag
// text. No gh, Docker or network.
//
//   pnpm test:file test/report-followup-evidence.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { createFollowUpBook, followUpsOf, FOLLOWUP_TITLE_MAX } = await import("../src/burndown.ts");
const { fakeTracker } = await import("./fixtures.ts");

const summary = async (record: object) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(
    join(root, ".sandcastle/logs/run.json"),
    JSON.stringify({ startedAt: "2026-10-05T06:00:00Z", finishedAt: "2026-10-05T07:00:00Z", stage: "report", exitCode: 1, pid: 1, tickets: { "5": { state: "stopped", title: "a", note: "finished before the run stopped" } }, ...record }),
  );
  const project = { root, baseBranch: "main", tracker: fakeTracker({ kind: "files" }), gates: [] } as any;
  return { root, out: render(await gather(project, () => undefined), true) };
};

const needsYou = (text: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("## Needs you"));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next);
};

/** The run record's `followUps` after a book heard these tag texts from ticket 5's review, nothing filed. */
const recordedFrom = (...tags: string[]) => {
  let kept: unknown[] = [];
  const book = createFollowUpBook(
    { update: (fields) => void (kept = fields.followUps) },
    { tracker: { ref: (id: string) => `#${id}`, comment: () => {}, create: () => "1" }, dryRun: false, write: async (fn) => fn(), exists: () => true },
  );
  for (const tag of tags) for (const f of followUpsOf(`<followup>${tag}</followup>\n`)) book.push({ ...f, from: "5", phase: "review" });
  return JSON.parse(JSON.stringify(kept)) as { title: string; fullTitle?: string; evidence?: string; from: string; phase: string; failed?: string }[];
};

const LONG = `${"The scheduler holds a lock across the whole landing of every ticket so ".repeat(2)}the second ticket waits for no reason`;
const EVIDENCE = "src/schedule.ts:120 takes the lock before the merge and releases it after the gates";
const WHY = "the shared .git changed while sandboxes ran, so nothing more was written to the tracker";

test("the record keeps a follow-up's evidence and, only when the title was cut, the uncut title", () => {
  assert.ok(LONG.length > FOLLOWUP_TITLE_MAX);
  const [long, short] = recordedFrom(`${LONG} - ${EVIDENCE}`, "short title - its evidence");
  assert.equal(long.evidence, EVIDENCE);
  assert.equal(long.fullTitle, LONG);
  assert.ok(long.title.length <= FOLLOWUP_TITLE_MAX && long.title.endsWith("…"));
  assert.deepEqual(short, { title: "short title", from: "5", phase: "review", evidence: "its evidence" });
});

test("a stopped run's unfiled follow-up shows its full title and an evidence line under its bullet", async () => {
  const followUps = recordedFrom(`${LONG} - ${EVIDENCE}`);
  const { out } = await summary({ stopped: "STOPPED: the ledger could not write", followUps });
  const needs = needsYou(out);
  const at = needs.indexOf(`- ${LONG} - from #5 (review): not filed, as the run stopped before it could - file it by hand`);
  assert.ok(at >= 0, needs.join("\n"));
  assert.equal(needs[at + 1], `  evidence: ${EVIDENCE}`);
  assert.equal(needs.filter((l) => l.startsWith("- ") && l.includes("scheduler holds")).length, 1, "the bullet is the only place the title is printed");
});

test("a follow-up whose filing failed shows its evidence under its bullet too", async () => {
  const followUps = [{ ...recordedFrom(`${LONG} - ${EVIDENCE}`)[0], failed: "gh: HTTP 502" }];
  const needs = needsYou((await summary({ stopped: "STOPPED: x", followUps })).out);
  const at = needs.indexOf(`- ${LONG} - from #5 (review): filing it for triage failed (gh: HTTP 502) - file it by hand`);
  assert.ok(at >= 0, needs.join("\n"));
  assert.equal(needs[at + 1], `  evidence: ${EVIDENCE}`);
});

test("a .git-withheld follow-up shows its full title and evidence under its bullet", async () => {
  const followUps = recordedFrom(`${LONG} - ${EVIDENCE}`, "short title - short evidence").map((f) => ({ ...f, failed: WHY }));
  const needs = needsYou((await summary({ stopped: "STOPPED: x", stoppedWhat: "the shared .git changed while sandboxes ran", followUpsWithheld: WHY, followUps })).out);
  const at = needs.indexOf(`- ${LONG} - from #5 (review)`);
  assert.ok(at >= 0, needs.join("\n"));
  assert.equal(needs[at + 1], `  evidence: ${EVIDENCE}`);
  const short = needs.indexOf("- short title - from #5 (review)");
  assert.ok(short >= 0);
  assert.equal(needs[short + 1], "  evidence: short evidence");
});

test("a follow-up with empty evidence renders exactly the bullet it always did", async () => {
  const followUps = recordedFrom("no evidence given here", "failing one").map((f, i) => ({ ...f, ...(i ? { failed: "gh: HTTP 502" } : {}) }));
  assert.ok(followUps.every((f) => f.evidence === undefined), "nothing is recorded for empty evidence");
  const needs = needsYou((await summary({ stopped: "STOPPED: x", followUps })).out);
  const at = needs.indexOf("- no evidence given here - from #5 (review): not filed, as the run stopped before it could - file it by hand");
  assert.ok(at >= 0, needs.join("\n"));
  assert.ok(!needs[at + 1]?.includes("evidence:"));
  const failed = needs.indexOf("- failing one - from #5 (review): filing it for triage failed (gh: HTTP 502) - file it by hand");
  assert.ok(failed >= 0, needs.join("\n"));
  assert.ok(!needs[failed + 1]?.includes("evidence:"));
  // A record from before this field existed has none either.
  const old = needsYou((await summary({ stopped: "STOPPED: x", followUps: [{ title: "old entry", from: "5", phase: "review" }] })).out);
  assert.ok(old.includes("- old entry - from #5 (review): not filed, as the run stopped before it could - file it by hand"));
  assert.ok(!old.some((l) => l.includes("evidence:")));
});

test("a 5,000-character evidence prints cut at 500 characters with the log path, while run.json holds it whole", async () => {
  const whole = `${"x".repeat(60)} `.repeat(82).trim();
  assert.ok(whole.length >= 5000);
  const followUps = recordedFrom(`${LONG} - ${whole}`);
  assert.equal(followUps[0].evidence, whole);
  const { root, out } = await summary({ stopped: "STOPPED: x", followUps });
  const line = needsYou(out).find((l) => l.startsWith("  evidence: "))!;
  assert.ok(line, "an evidence line");
  const shown = line.slice("  evidence: ".length, line.indexOf("… (cut short"));
  assert.equal(shown.length, 499);
  assert.equal(shown, whole.slice(0, 499));
  assert.match(line, /… \(cut short - .*\.sandcastle\/logs\/agent-issue-5-\*\.log\)$/);
  assert.ok(!line.includes(whole.slice(0, 600)));
  const onDisk = JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")).followUps[0];
  assert.equal(onDisk.evidence, whole, "run.json is not cut");
});

test("an evidence of exactly 500 characters is printed whole", async () => {
  const exact = "y".repeat(500);
  const { out } = await summary({ stopped: "STOPPED: x", followUps: recordedFrom(`a problem - ${exact}`) });
  assert.ok(needsYou(out).includes(`  evidence: ${exact}`));
});
