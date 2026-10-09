// The words after a `.git` guard stop: the next step matches the cause (a moved base may be a person's own commit,
// a changed file in `.git` may not), the re-gate line says the stop skipped it, the reason follow-ups were held
// back is said once for the set, and the stop's message is printed once. The summary is read from a run record on
// disk, as `sandcastle report` does; no gh, Docker or network.
//
//   pnpm test:file test/report-guard-stop.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { stoppedLine } = await import("../src/ledger.ts");
const { GuardStop } = await import("../src/guard.ts");
const { reportedError, wasReported, OperatorError } = await import("../src/errors.ts");
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
  return render(await gather(project, () => undefined), true);
};

const section = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next);
};

const FILE_STOP = "STOPPED at the end of a pipeline: .git/config changed while sandboxes ran. A sandbox may have tampered with the shared .git.";
const FILE_WHAT = "the shared .git changed while sandboxes ran";
const BASE_STOP = "STOPPED at the end of a pipeline: main moved while sandboxes ran (abc1234 by T, now: edit).";

test("a moved base's next step says it may be your own commit", async () => {
  const out = await summary({ stopped: BASE_STOP, stoppedWhat: "main moved while sandboxes ran" });
  assert.match(section(out, "## Next step").join("\n"), /^1\. Check what stopped the run \(above\)\. If it is your own commit, `sandcastle run` again - #5 finished and land then\./m);
});

test("a changed file in .git does not call the cause your own commit", async () => {
  const out = await summary({ stopped: FILE_STOP, stoppedWhat: FILE_WHAT });
  const next = section(out, "## Next step").join("\n");
  assert.doesNotMatch(next, /your own commit/);
  assert.match(next, /^1\. Check what stopped the run \(above\): it names what changed in the shared \.git and how to inspect it\. Once that is put right or understood, `sandcastle run` again - #5 finished and land then\./m);
});

test("a stopped run's re-gate line says the stop skipped it", async () => {
  const out = await summary({ stopped: FILE_STOP, stoppedWhat: FILE_WHAT });
  assert.match(out, /^Merged main not re-gated \(the stop skipped it\)\.$/m);
  assert.doesNotMatch(out, /no result recorded/);
});

test("the reason follow-ups were held back is said once under Needs you, not after each", async () => {
  const why = `${FILE_WHAT}, so nothing more was written to the tracker`;
  const followUps = Array.from({ length: 9 }, (_, i) => ({ title: `problem ${i}`, from: "5", phase: "review", failed: why }));
  const out = await summary({ stopped: FILE_STOP, stoppedWhat: FILE_WHAT, followUpsWithheld: why, followUps });
  const needs = section(out, "## Needs you");
  assert.equal(needs.filter((l) => l.includes("nothing more was written")).length, 1, needs.join("\n"));
  assert.equal(needs.filter((l) => /^- problem \d - from #5 \(review\)$/.test(l)).length, 9);
  assert.match(out, / - 9 need you - /, "each is still one to file by hand");
});

test("a follow-up whose filing failed for another reason keeps its own reason", async () => {
  const why = `${FILE_WHAT}, so nothing more was written to the tracker`;
  const followUps = [
    { title: "held", from: "5", phase: "review", failed: why },
    { title: "broken", from: "5", phase: "review", failed: "gh: HTTP 502" },
  ];
  const needs = section(await summary({ stopped: FILE_STOP, stoppedWhat: FILE_WHAT, followUpsWithheld: why, followUps }), "## Needs you");
  assert.ok(needs.includes("- broken - from #5 (review): filing it for triage failed (gh: HTTP 502) - file it by hand"), needs.join("\n"));
  assert.ok(needs.includes("- held - from #5 (review)"));
});

test("the live STOPPED line names the cause and leaves the full statement to the summary", () => {
  const error = new GuardStop("STOPPED at x: main moved while sandboxes ran (abc1234 by T: edit). Check the commits.", { what: "main moved while sandboxes ran", detail: "(abc1234 by T: edit)" });
  const line = stoppedLine({ kind: "tampered", error } as any, (id) => `#${id}`);
  assert.equal(line, "STOPPED landing: main moved while sandboxes ran - the run finishes what is in flight and lands nothing more; the closing summary says what to check.");
});

test("an error the summary printed is marked, and another is not", () => {
  const stop = new OperatorError("STOPPED x");
  assert.equal(wasReported(stop), false);
  assert.equal(reportedError(stop), stop);
  assert.equal(wasReported(stop), true);
  assert.equal(wasReported(new OperatorError("STOPPED x")), false);
});

// burndown() needs Docker, so no test drives it: the call sites are held by its source.
test("burndown records the cause, says the withheld reason once and rethrows the stop as reported; the CLI prints a reported stop no more", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  const stop = src.slice(src.indexOf("const stopLanding = "), src.indexOf("const { endings, stop } = await schedule"));
  assert.match(stop, /if \(safety\) run\.update\(\{ stoppedWhat: guardWords\(error\)\.what \}\)/);
  assert.match(stop, /throw reportedError\(error\)/);
  assert.match(src, /run\.update\(\{ followUpsWithheld: unsafe \}\)/);
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /if \(!wasReported\(error\)\) \{\n\s+console\.error\(/);
});
