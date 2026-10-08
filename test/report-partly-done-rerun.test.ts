// A ticket that landed with a criterion left undone stays open and queued, so the next run takes it:
// the closing summary lists it under Runnable now, the autonomy loop counts it as re-runnable, and
// the promise matches. When the agent's own `<unmet>` line says the remainder needs a person,
// no run is promised: the summary suggests the hold label instead. Ticket files in a temp repo
// (files tracker) and a made-up run record; no Docker, gh, model calls or network.
//
//   node --test test/report-partly-done-rerun.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
delete process.env.LINEAR_API_KEY;
const { afterTurn, drainStop, needsDecision, nextTurn, remainderNote, rerunList, rerunnable } = await import("../src/autonomy.ts");
const { gather, render } = await import("../src/report.ts");
const { partlyDoneComment } = await import("../src/ledger.ts");
const { recordRun } = await import("../src/run.ts");
const { refOf } = await import("../src/tracker.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const ROUTINE = "the export module does not use the new rule yet";
const PERSON = "the old endpoint's removal is the maintainer's decision";

const root = mkdtempSync(join(tmpdir(), "sandcastle-partly-rerun-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
const dir = join(root, ".scratch/shop/issues");
mkdirSync(dir, { recursive: true });
const ticket = (title: string, status: string) => `# ${title}\n\nStatus: ${status}\n\nDo it.\n\n## Comments\n`;
writeFileSync(join(dir, "01-export.md"), ticket("Export", "ready-for-agent"));
writeFileSync(join(dir, "02-endpoint.md"), ticket("Endpoint", "ready-for-agent"));
writeFileSync(join(dir, "03-held.md"), ticket("Held by hand", "ready-for-human"));
writeFileSync(join(dir, "04-done.md"), ticket("Done", "done"));
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: root });
git("add", "-A");
git("commit", "-qm", "t");
const project = { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;

const section = (text: string, heading: string) => text.split(heading)[1]?.split("\n## ")[0] ?? "";

test("needsDecision reads a person's decision out of the agent's words, and not a routine remainder", () => {
  assert.equal(needsDecision(PERSON), true);
  assert.equal(needsDecision("left for a human to decide"), true);
  assert.equal(needsDecision(ROUTINE), false);
  assert.equal(needsDecision("the README does not mention the new flag"), false);
});

test("the tracker comment promises a run only for a remainder an agent can do", () => {
  const o = { branch: "agent/issue-1", commits: 1, repairs: 0 };
  assert.match(partlyDoneComment({ ...o, unmet: ROUTINE }, "tsc"), /The next run picks up the remainder\./);
  const asked = partlyDoneComment({ ...o, unmet: PERSON }, "tsc");
  assert.doesNotMatch(asked, /picks up the remainder/);
  assert.match(asked, /needs a person: do or decide it.*hold label/);
  assert.match(remainderNote(PERSON, "`sandcastle run`"), /hold label/);
  assert.equal(remainderNote(ROUTINE, "`sandcastle run`"), "The next `sandcastle run` picks up the remainder.");
});

test("gather lists a partly-done ticket as partial only while it is still queued", async () => {
  recordRun(project, {
    issues: ["shop-01", "shop-02", "shop-03"],
    tickets: {
      "shop-01": { state: "merged", title: "Export", unmet: ROUTINE },
      "shop-02": { state: "merged", title: "Endpoint", unmet: PERSON },
      "shop-03": { state: "merged", title: "Held by hand", unmet: ROUTINE },
      "shop-04": { state: "merged", title: "Done", unmet: ROUTINE },
    },
  });
  const facts = await gather(project);
  // shop-03 was moved to the hold label by a person, shop-04 closed: neither is in the queue.
  assert.deepEqual([...(facts.partial ?? [])].sort(), ["shop-01", "shop-02"]);
});

const facts = (partial: string[] | undefined, unmet: string, extra = {}) => ({
  base: "main",
  tracker: "github" as const,
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:45:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets: { "7": { state: "merged" as const, title: "Export", unmet } },
  runnable: [],
  partial,
  holdLabel: "ready-for-human",
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...extra,
});

test("a queued partly-done ticket is runnable now, and re-runnable for the autonomy loop", () => {
  const f = facts(["7"], ROUTINE);
  const out = render(f, true);
  assert.match(section(out, "## Runnable now / Still blocked"), /Runnable now: #7 \(merged partly done - the remainder is still open\)/);
  assert.match(section(out, "## Needs you"), /merged, partly done: .* - the ticket is still open, and the next `sandcastle run` picks up the remainder/);
  const again = rerunnable(f);
  assert.deepEqual(again?.partial, ["7"]);
  assert.equal(rerunList(again!, refOf), "#7 (partly done: #7)");
  assert.equal(nextTurn(2, 1, again), "run");
  assert.equal(nextTurn("drain", 1, again), "run");
  assert.deepEqual(afterTurn(f, "drain", 1, () => true)?.ids, ["7"]);
  // Closed by hand since the turn: dropped, as a conflicted ticket is.
  assert.equal(afterTurn(f, "drain", 1, () => false)?.verdict, "stop");
});

test("a remainder that needs a person is not runnable: the summary suggests the hold label", () => {
  const f = facts(["7"], PERSON);
  const out = render(f, true);
  assert.match(section(out, "## Runnable now / Still blocked"), /none|^$/);
  assert.doesNotMatch(section(out, "## Runnable now / Still blocked"), /#7/);
  assert.doesNotMatch(out, /picks up the remainder/);
  assert.match(section(out, "## Needs you"), /needs a person \(the agent's note\).*move it to the hold label \(`ready-for-human`\)/);
  assert.match(section(out, "## Next step"), /Decide what is left on #7.*hold label \(`ready-for-human`\)/);
  assert.deepEqual(rerunnable(f)?.partial, []);
  assert.equal(afterTurn(f, "drain", 1, () => true)?.verdict, "stop");
});

test("a partly-done ticket no longer in the queue is not promised to any run", () => {
  const out = render(facts([], ROUTINE), true);
  assert.doesNotMatch(out, /picks up the remainder/);
  assert.doesNotMatch(section(out, "## Runnable now / Still blocked"), /#7 \(/);
  assert.match(section(out, "## Needs you"), /no longer in the queue/);
  assert.match(section(out, "## Next step"), /#7 merged partly done and is no longer in the queue/);
});

test("when the queue could not be read the old promise stands, unchanged", () => {
  const out = render(facts(undefined, ROUTINE), true);
  assert.match(section(out, "## Needs you"), /and the next `sandcastle run` picks up the remainder/);
  assert.match(section(out, "## Next step"), /the next `sandcastle run` picks up the remainder/);
});

test("drain stops on a remainder left partly done in two turns running", () => {
  const turn = { landed: 1, released: [], conflicted: [], partial: ["7"] };
  assert.equal(drainStop(turn, undefined), undefined);
  assert.equal(drainStop(turn, { ...turn, partial: ["8"] }), undefined);
  assert.match(drainStop(turn, turn, (id) => `#${id}`) ?? "", /^#7 left partly done in two turns running$/);
});
