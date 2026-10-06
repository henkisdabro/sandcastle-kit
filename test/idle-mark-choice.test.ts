// The idle mark's per-project choices (mod/hooks/idle.ts), pure: hiding, a dismissal and what ends
// it, the command's arguments and its report. No Claude Code needed; the hooks are tested in mod/tests/.
//
//   node --test test/idle-mark-choice.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceAfter, COUNT_MS, type Entry, markAction, markReport, markText, parseChoice } from "../mod/hooks/idle.ts";

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const read = (ids: string[], ageMin = 1, ok = true): Entry => ({ at: NOW - ageMin * MIN, ids, ok, tried: NOW - ageMin * MIN });
const mark = (extra: object) => markText({ setUp: true, idleMark: true, now: NOW, ...extra });
const READY = (n: number) => `sandcastle · ${n} ready - /sandcastle run`;

test("markText: hidden clears the line, with or without a count", () => {
  assert.equal(mark({ hidden: true }), undefined);
  assert.equal(mark({ hidden: true, entry: read(["1", "2"]) }), undefined);
  assert.equal(mark({ hidden: false, entry: read(["1", "2"]) }), READY(2));
});

test("markText: a dismissal takes the count off and leaves the mark", () => {
  assert.equal(mark({ entry: read(["1", "2", "3"]), dismissed: ["1", "2", "3"] }), "sandcastle");
  assert.equal(mark({ entry: read([]), dismissed: [] }), "sandcastle");
});

test("markText: dismissed and then a new ready id, the count is back", () => {
  assert.equal(mark({ entry: read(["1", "2", "3", "4"]), dismissed: ["1", "2", "3"] }), READY(4));
  // The dismissal holds nothing for a ticket it never saw, even when another has left.
  assert.equal(mark({ entry: read(["1", "2", "9"]), dismissed: ["1", "2", "3"] }), READY(3));
  assert.equal(mark({ entry: read(["1"]), dismissed: [] }), READY(1));
});

test("markText: dismissed and then an id gone, the line stays quiet", () => {
  assert.equal(mark({ entry: read(["1", "2"]), dismissed: ["1", "2", "3"] }), "sandcastle");
  assert.equal(mark({ entry: read([]), dismissed: ["1", "2", "3"] }), "sandcastle");
});

test("markText: hidden wins over a dismissal; a count too old to show is bare either way", () => {
  assert.equal(mark({ hidden: true, entry: read(["1"]), dismissed: ["1"] }), undefined);
  assert.equal(mark({ entry: read(["1"], COUNT_MS / MIN + 1) }), "sandcastle");
  assert.equal(mark({ entry: read(["1", "2"], COUNT_MS / MIN + 1), dismissed: ["1"] }), "sandcastle");
});

test("markAction: the three arguments, none for the report, anything else is unknown", () => {
  const table: [string, string | undefined][] = [
    ["dismiss", "dismiss"],
    ["hide", "hide"],
    ["show", "show"],
    ["", "report"],
    ["  ", "report"],
    [" Hide ", "hide"],
    ["hide now", undefined],
    ["dismissed", undefined],
    ["status", undefined],
  ];
  for (const [args, action] of table) assert.equal(markAction(args), action, JSON.stringify(args));
});

test("choiceAfter: dismiss records the count's ids, hide keeps a dismissal, show ends both", () => {
  const entry = read(["1", "2"]);
  assert.deepEqual(choiceAfter("dismiss", { hidden: false }, entry, NOW), { hidden: false, dismissed: ["1", "2"] });
  // A count too old to show was not seen: nothing is dismissed, so a ticket ready later is shown.
  assert.deepEqual(choiceAfter("dismiss", { hidden: false }, read(["1"], 90), NOW), { hidden: false, dismissed: [] });
  assert.deepEqual(choiceAfter("dismiss", { hidden: false }, undefined, NOW), { hidden: false, dismissed: [] });
  assert.deepEqual(choiceAfter("hide", { hidden: false, dismissed: ["1"] }, entry, NOW), { hidden: true, dismissed: ["1"] });
  assert.deepEqual(choiceAfter("show", { hidden: true, dismissed: ["1"] }, entry, NOW), { hidden: false });
});

test("parseChoice: only what the mod stores, since the store is shared", () => {
  assert.deepEqual(parseChoice({ hidden: true }), { hidden: true });
  assert.deepEqual(parseChoice({ hidden: false, dismissed: ["1"] }), { hidden: false, dismissed: ["1"] });
  for (const bad of [undefined, null, "x", [], {}, { hidden: "yes" }, { hidden: false, dismissed: "1" }, { hidden: false, dismissed: [1] }]) {
    assert.equal(parseChoice(bad), undefined, JSON.stringify(bad));
  }
});

test("markReport: shown, hidden here or machine-wide, dismissed, and the cached count with its age", () => {
  const base = { setUp: true, idleMark: true, now: NOW };
  assert.equal(markReport({ ...base }), "Idle mark: shown.\nCached count: No count read yet.");
  assert.equal(markReport({ ...base, entry: read(["1", "2", "3"], 4) }), "Idle mark: shown.\nCached count: 3 ready, read 4 min ago.");
  assert.match(markReport({ ...base, hidden: true }), /^Idle mark: hidden in this project/);
  assert.match(markReport({ ...base, idleMark: false }), /^Idle mark: hidden on this machine \("idleMark": false/);
  assert.match(markReport({ ...base, idleMark: false, hidden: true }), /on this machine .* and in this project/);
  assert.match(markReport({ ...base, setUp: false }), /^Idle mark: not shown: this project is not set up/);
  const dismissed = markReport({ ...base, entry: read(["1"]), dismissed: ["1", "2"] });
  assert.match(dismissed, /^Idle mark: shown without a count: dismissed/);
  // A dismissal a new ticket has ended is not reported as one.
  assert.equal(markReport({ ...base, entry: read(["1", "3"]), dismissed: ["1", "2"] }), "Idle mark: shown.\nCached count: 2 ready, read 1 min ago.");
  // A stale count is told from an empty queue.
  assert.equal(markReport({ ...base, entry: read([], 90) }), "Idle mark: shown.\nCached count: 0 ready, read 1 h 30 min ago; too old to show.");
  assert.match(markReport({ ...base, entry: read(["1"], 5, false) }), /read 5 min ago \(the latest read failed\)\.$/);
});
