// The closing summary of a run that took several turns carries what the earlier turns left for a person:
// a held branch, a partly done remainder that needs a decision, a check by hand, a follow-up filed for
// triage - each marked with its turn, with their Next steps and in the headline's counts. Made-up run.json
// and history.jsonl records of one run's two turns over a ticket-files tracker in a temp git repo; no Docker,
// model or network.
//
//   pnpm test:file test/report-drain-carry.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { gather, render } = await import("../src/report.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Project = import("../src/config.ts").Project;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const body = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith(heading));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, next < 0 ? undefined : next).join("\n");
};

const DECIDE = "the remainder is the maintainer's decision";
const PID = 4242;
const kit = () => "sandcastle run";

// Turn 1 ended with: shop-01 held (a branch with work), shop-02 merged partly done (its remainder needs a
// person), shop-03 merged with a check by hand, shop-04 held (turn 2 ran it again), one follow-up filed for
// triage. Turn 2 re-ran shop-04 and landed it.
const turn1 = (over: Record<string, unknown> = {}) => ({
  orchestrator: "demo",
  pid: PID,
  startedAt: "2026-10-01T08:00:00.000Z",
  finishedAt: "2026-10-01T08:30:00.000Z",
  exitCode: 0,
  settings: { autonomy: "drain", turn: 1, cap: 20 },
  tickets: {
    "shop-01": { state: "held", title: "Held work", note: "changes src/a.ts" },
    "shop-02": { state: "merged", title: "Half done", unmet: DECIDE },
    "shop-03": { state: "merged", title: "Needs eyes", ungated: "the checkout page has no test" },
    "shop-04": { state: "held", title: "Run again", note: "changes src/b.ts" },
  },
  followUps: [{ title: "Retry the upload", from: "shop-01", phase: "implement", id: "shop-09" }],
  verify: null,
  ...over,
});
const turn2 = (over: Record<string, unknown> = {}) => ({
  orchestrator: "demo",
  pid: PID,
  startedAt: "2026-10-01T08:31:00.000Z",
  finishedAt: "2026-10-01T09:00:00.000Z",
  exitCode: 0,
  settings: { autonomy: "drain", turn: 2, cap: 20 },
  tickets: { "shop-04": { state: "merged", title: "Run again" } },
  verify: null,
  ...over,
});

/** A project whose last record is `current` and whose history.jsonl holds `history`, in that order. */
const project = (t: { after: (fn: () => void) => void }, current: object, history: object[]): Project => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-drain-carry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  const dir = join(root, ".scratch/shop/issues");
  mkdirSync(dir, { recursive: true });
  const ticket = (title: string, status: string) => `# ${title}\n\nStatus: ${status}\n\nDo it.\n\n## Comments\n`;
  writeFileSync(join(dir, "01-held.md"), ticket("Held work", "ready-for-agent"));
  writeFileSync(join(dir, "02-half.md"), ticket("Half done", "ready-for-agent"));
  writeFileSync(join(dir, "03-eyes.md"), ticket("Needs eyes", "done"));
  writeFileSync(join(dir, "04-again.md"), ticket("Run again", "done"));
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  for (const [id, file] of [["shop-01", "a.ts"], ["shop-04", "b.ts"]]) {
    git(root, "checkout", "-q", "-b", `agent/issue-${id}`);
    writeFileSync(join(root, file), "work\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", `work ${id}`);
    git(root, "checkout", "-q", "main");
  }
  const logs = join(root, ".sandcastle/logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "run.json"), JSON.stringify(current));
  writeFileSync(join(logs, "history.jsonl"), history.map((h) => JSON.stringify(h) + "\n").join(""));
  return { name: "demo", root, baseBranch: "main", label: "ready-for-agent", gates: [], tracker: fakeTracker({ kind: "files" }) } as unknown as Project;
};

const summary = async (p: Project) => render(await gather(p, kit), true);

test("the last turn's summary carries what an earlier turn left for a person, marked with its turn", async (t) => {
  // A finished turn leaves its record in history as well as in run.json: that copy is not an earlier turn.
  const out = await summary(project(t, turn2(), [turn1(), turn2()]));
  const needs = body(out, "## Needs you");
  assert.match(needs, /^- shop-01 Held work - changes src\/a\.ts - 1 file\(s\) \(turn 1\)$/m);
  assert.match(needs, /^  review: git log -p main\.\.agent\/issue-shop-01 {3}merge: git merge --no-ff agent\/issue-shop-01$/m);
  // The wording for a remainder only a person can do or decide, as a turn's own summary has it.
  assert.match(needs, /^- shop-02 Half done - merged, partly done: the remainder is the maintainer's decision - the ticket is still open; the remainder needs a person .*hold label.* \(turn 1\)$/m);
  assert.match(needs, /^- shop-03 Needs eyes - merged - check by hand: the checkout page has no test \(turn 1\)$/m);
  assert.match(needs, /^- shop-09 Retry the upload - filed for triage from shop-01 \(implement\): triage it, then queue or close it \(turn 1\)$/m);
  // The follow-up is for triage: under its heading, after the Needs you bullets.
  assert.ok(needs.indexOf("### To triage") < needs.indexOf("shop-09"));
  assert.ok(needs.indexOf("shop-03") < needs.indexOf("### To triage"));

  const next = body(out, "## Next step");
  assert.match(next, /Review and merge the 1 held branch\(es\) \(commands above\) \(turn 1\)\./);
  assert.match(next, /Do or decide what is left on shop-02 .* \(turn 1\)\./);
  assert.match(next, /Check shop-03 by hand: .* \(turn 1\)\./);

  // The headline counts them: shop-01, shop-02 and shop-03 need a person, one follow-up to triage.
  assert.match(out, / - 3 need you - 0 need fixing - 1 to triage - /);
});

test("a ticket a later turn ran again shows only the later ending", async (t) => {
  const out = await summary(project(t, turn2(), [turn1()]));
  // shop-04 was held in turn 1 and landed in turn 2: no held branch, no step for it.
  assert.doesNotMatch(body(out, "## Needs you"), /shop-04/);
  assert.match(body(out, "## Next step"), /Review and merge the 1 held branch/);
  assert.match(body(out, "## Done"), /1 merged and marked done in their ticket files \(committed on your local main\): shop-04/);
});

test("a ticket a later turn only left waiting keeps its earlier ending", async (t) => {
  const waiting = turn2({ tickets: { "shop-01": { state: "blocked", title: "Held work", note: "waits for shop-09 (not in this run)" } } });
  const out = await summary(project(t, waiting, [turn1()]));
  assert.match(body(out, "## Needs you"), /^- shop-01 Held work - .* \(turn 1\)$/m);
});

test("a history line of another run carries nothing", async (t) => {
  for (const [why, line] of [
    ["another pid", turn1({ pid: PID + 1 })],
    ["another project", turn1({ orchestrator: "other" })],
    ["the same pid but another turn", turn1({ settings: { autonomy: "drain", turn: 5 } })],
    ["no turn number", turn1({ settings: undefined })],
  ] as const) {
    const out = await summary(project(t, turn2(), [line]));
    assert.doesNotMatch(out, /\(turn \d+\)/, why);
    assert.match(out, / - 0 need you - /, why);
  }
});

test("the turns count down without a gap: a turn missing from history carries nothing", async (t) => {
  // Turn 3 is current, turn 2 is in history, turn 1 is not: turn 2's line cannot be told to belong to this run.
  const three = turn2({ startedAt: "2026-10-01T09:10:00.000Z", settings: { autonomy: "drain", turn: 3, cap: 20 } });
  const out = await summary(project(t, three, [turn2({ tickets: { "shop-01": { state: "held", title: "Held work", note: "changes src/a.ts" } } })]));
  assert.doesNotMatch(out, /\(turn \d+\)/);
});

test("three turns: each earlier turn is carried, oldest first", async (t) => {
  const mid = turn2({ tickets: { "shop-03": { state: "merged", title: "Needs eyes", ungated: "check the cart" } } });
  const three = { ...turn2(), startedAt: "2026-10-01T09:10:00.000Z", settings: { autonomy: "drain", turn: 3, cap: 20 }, tickets: { "shop-04": { state: "merged", title: "Run again" } } };
  const out = await summary(project(t, three, [turn1(), mid]));
  const needs = body(out, "## Needs you");
  // shop-03 was checked again in turn 2: its turn 2 ending replaces turn 1's.
  assert.doesNotMatch(needs, /the checkout page has no test/);
  assert.match(needs, /check by hand: check the cart \(turn 2\)$/m);
  assert.ok(needs.indexOf("(turn 1)") < needs.indexOf("(turn 2)"));
});

test("a turn-1 record carries nothing, and the facts have no carried turns", async (t) => {
  const first = turn1();
  const p = project(t, first, [first]);
  assert.equal((await gather(p, kit)).carried, undefined);
  assert.doesNotMatch(await summary(p), /\(turn \d+\)/);
});

test("a partly done ticket closed since is not carried", async (t) => {
  const p = project(t, turn2(), [turn1()]);
  writeFileSync(join(p.root, ".scratch/shop/issues/02-half.md"), "# Half done\n\nStatus: done\n\nDo it.\n\n## Comments\n");
  const out = await summary(p);
  assert.doesNotMatch(body(out, "## Needs you"), /shop-02/);
  assert.match(body(out, "## Needs you"), /shop-01/);
});
