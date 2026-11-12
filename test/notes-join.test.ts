// The notes agents give (a report's `ungated` and `unmet`) are joined as one note: no ".;" at a joint,
// repeats dropped, an ellipsis kept (#945).
//
//   pnpm test:file test/notes-join.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-nj-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-nj-"));
const { joinNotes, saidOf } = await import("../src/burndown.ts");
const { COMPLETION_SIGNAL } = await import("../src/agents.ts");
type Report = import("../src/agents.ts").Report;

const reportOf = (over: Partial<Report> = {}): Report => ({
  signal: COMPLETION_SIGNAL,
  unmet: { assessed: true, items: [] },
  changelog: [],
  followups: [],
  ungated: [],
  ...over,
});

test("notes are joined with no full stop before the joint, and one at the end", () => {
  assert.equal(joinNotes(["Check A.", "Check B; visual inspection was unavailable."]), "Check A; Check B; visual inspection was unavailable.");
});

test("a repeat that differs only by its full stop is one note, the first one's text", () => {
  assert.equal(joinNotes(["Check A.", "Check A"]), "Check A.");
  assert.equal(joinNotes(["Check A", "Check A."]), "Check A");
});

test("an ellipsis keeps its dots and gets no full stop", () => {
  assert.equal(joinNotes(["Wait for it...", "Then look…"]), "Wait for it...; Then look…");
});

test("empty and blank notes are dropped, and no notes is empty", () => {
  assert.equal(joinNotes(["  ", "", " Check A. "]), "Check A.");
  assert.equal(joinNotes([]), "");
});

test("a report's ungated items come out as one note", () => {
  const text = "done";
  const said = saidOf(text, { report: reportOf({ ungated: ["Check A.", "Check B."] }), output: text });
  assert.equal(said.ungated, "Check A; Check B.");
});

test("a report's unmet items come out as one note", () => {
  const text = "done";
  const said = saidOf(text, { report: reportOf({ unmet: { assessed: true, items: [{ who: "agent", text: "Do A." }, { who: "agent", text: "Do B." }] } }), output: text });
  assert.equal(said.unmet, "Do A; Do B.");
});

// The pipeline's `agentsSaid` joins the implementer's and the reviewers' notes across passes: a
// pipeline test needs a whole faked harness, so its two joins are held by their source.
test("the notes said across passes are joined by joinNotes too", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  const said = source.slice(source.indexOf("const agentsSaid = () => {"));
  const body = said.slice(0, said.indexOf("\n      };"));
  assert.match(body, /unmet: left\.length \? cutAtWord\(joinNotes\(left\), UNGATED_MAX\)/);
  assert.match(body, /ungated: ungated\.length \? cutAtWord\(joinNotes\(ungated\), UNGATED_MAX\)/);
});
