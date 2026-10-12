// The harness the status view is held to: the fact reader that compares two frames of one fixture without their layout. A frame hides facts - a column
// that gave way in a narrow pane, a note cut with `…` - and those compare as unknown, so the same
// fixture drawn at 80, 120, 200 and 330 columns reads as the same facts. No Docker, no network, no model calls.
//
//   pnpm test:file test/status-facts.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GROUPS, TICKET_STATES } from "../mod/hooks/run-record.ts";
import { KIT, runNode } from "./cli-spawn.ts";
import { buildFixture, NOW, type Fixture, type FixtureKind } from "./status-fixture.ts";
import { agree, compareFacts, drawFrame, factsAt, type Facts } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-facts-"));
const fixtures = Object.fromEntries((["live", "legacy", "ended"] as FixtureKind[]).map((kind) => [kind, buildFixture(kind, join(TMP, kind))])) as Record<FixtureKind, Fixture>;
after(() => {
  for (const f of Object.values(fixtures)) f.stop();
  rmSync(TMP, { recursive: true, force: true });
});

const WIDTHS = [80, 120, 200, 330];

test("the clock preload gives the TypeScript view the fixture's time, and leaves the real one without it", () => {
  const code = "console.log(JSON.stringify([Date.now(), new Date().toISOString(), new Date(0).toISOString(), new Date(2026, 0, 2).getFullYear()]))";
  const run = (env: Record<string, string>) => JSON.parse(runNode(["--import", join(KIT, "test/status-clock.ts"), "-e", code], { encoding: "utf8", env: { ...process.env, ...env } }).stdout);
  assert.deepEqual(run({ SANDCASTLE_TEST_NOW: String(NOW) }), [NOW * 1000, "2026-10-10T12:00:00.000Z", "1970-01-01T00:00:00.000Z", 2026]);
  const real = run({ SANDCASTLE_TEST_NOW: "" });
  assert.ok(Math.abs(real[0] - Date.now()) < 60_000);
});

// ---------------------------------------------------------------------------
// The fact reader.
// ---------------------------------------------------------------------------

const at = (kind: FixtureKind, cols: number, env: Record<string, string> = {}) => factsAt(fixtures[kind], cols, env);

for (const kind of ["live", "legacy", "ended"] as FixtureKind[]) {
  test(`the ${kind} fixture reads as the same facts at 80, 120, 200 and 330 columns`, () => {
    const widest = at(kind, 330, { SANDCASTLE_LINKS: "1" });
    for (const cols of WIDTHS.filter((w) => w !== 330)) assert.deepEqual(compareFacts(at(kind, cols, { SANDCASTLE_LINKS: "1" }), widest), [], `${cols} columns`);
    // Nothing is cut or hidden at the widest, so the comparison above is of whole facts there.
    assert.ok(widest.tickets.every((t) => !t.note.endsWith("…") && t.cpuMem !== undefined && t.tokens !== undefined && t.time !== undefined), "a fact hidden at 330 columns");
  });
}

test("the live fixture shows a ticket in every state, each in the group the shared table gives it", () => {
  const facts = at("live", 330);
  const { tickets } = fixtures.live;
  const GROUP_NAMES = { working: "working", "needs you": "needs you", ready: "ready to land", queued: "queued", blocked: "blocked", merged: "merged", other: "idle" } as const;
  const WORD: Record<string, string> = { implement: "impl", "cross-review": "codex", red: "gate red", nochange: "no change" };
  for (const state of TICKET_STATES) {
    const row = facts.tickets.find((t) => t.id === `#${tickets[state]}`);
    assert.ok(row, `no row for a ticket in state ${state}`);
    assert.equal(row.state, WORD[state] ?? state, `${state}: its word`);
    // "withdrawn" is the view's "left over" group, as the shared table's "other" is its "idle".
    const expected = state === "withdrawn" ? "left over" : GROUP_NAMES[GROUPS[state]];
    assert.equal(row.group, expected, `${state}: its group`);
  }
});

test("the live fixture's inferred rows and the run's own facts are read", () => {
  const facts = at("live", 330);
  const row = (id: string) => facts.tickets.find((t) => t.id === id)!;
  assert.deepEqual([row("#201").state, row("#201").group], ["finished", "ready to land"]);
  assert.deepEqual([row("#202").state, row("#202").group], ["left over", "left over"]);
  assert.deepEqual([row("#203").state, row("#203").group], ["later", "later"]);
  assert.deepEqual([row("#204").state, row("#204").group], ["orphaned", "needs you"]);
  // The container's CPU and memory, and none for a ticket without one.
  assert.equal(row("#204").cpuMem, "7.0c/2.1G");
  assert.equal(row(`#${fixtures.live.tickets.implement}`).cpuMem, "1.5c/276M");
  assert.equal(row("#103").cpuMem, "-");
  assert.equal(row(`#${fixtures.live.tickets.merged}`).tokens, "13.2M/52k");
  // The landed ticket's merge commit and its one commit are on the base, and not on its upstream.
  assert.deepEqual(facts.project, { name: "fixture", base: "main", clock: "13:00:00", unpushed: "↑2 unpushed" });
  assert.equal(facts.run.state, "running · 2h00m");
  assert.equal(facts.run.sandboxes, "2/6");
  assert.equal(facts.run.models, "implement sonnet-5-5/high, review opus-5-5/high");
  // The turn and the repair attempts are the run's facts wherever a layout shows them; the rest are its settings.
  assert.deepEqual([facts.run.turn, facts.run.repair], ["1/3", "2"]);
  assert.deepEqual(facts.settings, ["autonomy 2", "concurrency 3", "● cross-review gpt-5 high", "● usage-guard 95%", "● usage-pause 90%"]);
  assert.equal(facts.usage, "claude 5h 42% resets 15:00 week 61% resets Tue 13:00 (1m ago)");
  // The footer counts the run's own 23 tickets (8 + 7 + 1 + 2 + 1 + 1 + 1 + 2), the rows outside its record apart, but for the labelled tickets outside the run, which are `later`.
  assert.deepEqual(facts.counts, { working: 8, "needs you": 7, "ready to land": 1, queued: 2, blocked: 1, merged: 1, later: 3, "left over": 1, idle: 2 });
});

test("a ticket's link is read from the frame, the project's path as $PROJECT", () => {
  const facts = at("legacy", 120, { SANDCASTLE_LINKS: "1" });
  assert.equal(facts.hint, true);
  assert.equal(facts.tickets.find((t) => t.id === "#301")!.link, "$PROJECT/.sandcastle/logs/agent-issue-301-impl-301.log");
  assert.equal(facts.tickets.find((t) => t.id === "#304")!.link, undefined, "a ticket with no log has no link");
  assert.equal(at("legacy", 120).hint, false);
});

test("the ended fixture's rows are read from git, the logs and the outcomes", () => {
  const facts = at("ended", 330);
  const word = Object.fromEntries(facts.tickets.map((t) => [t.id, `${t.group}/${t.state}`]));
  assert.deepEqual(word, {
    "#404": "needs you/conflict", "#405": "needs you/gate red", "#406": "needs you/held", "#407": "needs you/held", "#408": "needs you/uncommitted",
    "#409": "needs you/crashed", "#410": "needs you/not landed", "#412": "needs you/stopped", "#403": "ready to land/ready", "#417": "queued/queued",
    "#418": "queued/queued", "#419": "blocked/blocked", "#401": "merged/merged", "#402": "merged/merged", "#415": "merged/merged", "#411": "left over/withdrawn",
    "#413": "idle/no change", "#414": "left over/left over", "#416": "idle/no branch",
  });
  assert.equal(facts.tickets.find((t) => t.id === "#401")!.time, "45m");
  assert.equal(facts.run.state, "ended (exit 0)");
});

// ---------------------------------------------------------------------------
// What a frame hides.
// ---------------------------------------------------------------------------

test("a column that gave way is unknown, and a note cut with … is the start of the other's", () => {
  const narrow = at("live", 80);
  const wide = at("live", 330);
  const row = (f: Facts, id: string) => f.tickets.find((t) => t.id === id)!;
  assert.equal(row(narrow, "#104").cpuMem, undefined, "CPU/MEM gave way at 80 columns");
  assert.ok(row(narrow, "#105").note.endsWith("…") && row(wide, "#105").note.startsWith(row(narrow, "#105").note.slice(0, -1)));
  assert.deepEqual(compareFacts(narrow, wide), []);
  assert.deepEqual([agree("a…", "abc"), agree("abc", "a…"), agree("b…", "abc"), agree(undefined, "abc"), agree("abc", "abd")], [true, true, false, true, false]);
});

test("a difference in a shown fact is found: a state, a time, a count, a note that is not a prefix", () => {
  const base = at("live", 120);
  const changed = structuredClone(base);
  const row = changed.tickets.find((t) => t.id === "#104")!;
  row.state = "review";
  row.time = "9m";
  row.note = "something else";
  changed.counts.working = 7;
  changed.tickets.pop();
  const diffs = compareFacts(base, changed);
  assert.ok(diffs.some((d) => d.startsWith("#104 state")), diffs.join("\n"));
  assert.ok(diffs.some((d) => d.startsWith("#104 time")));
  assert.ok(diffs.some((d) => d.startsWith("#104 note")));
  assert.ok(diffs.some((d) => d.startsWith("count working")));
  assert.ok(diffs.some((d) => d.startsWith("tickets shown")));
  assert.notDeepEqual(compareFacts(at("live", 120), at("ended", 120)), []);
});

test("every fixture frame fits its pane at every width", () => {
  for (const kind of ["live", "legacy", "ended"] as FixtureKind[]) {
    for (const cols of WIDTHS) {
      const { frame, status, stderr } = drawFrame(fixtures[kind], { cols });
      assert.equal(status, 0, stderr);
      for (const line of frame.split("\n")) assert.ok([...line].length <= cols, `${kind} at ${cols}: wider than the pane: ${line}`);
    }
  }
});
