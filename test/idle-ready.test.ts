// The idle mark's ready count (mod/hooks/idle.ts), pure: which tickets are ready, when the queue
// is read again, and what the line says of a cached read. No Claude Code needed; the hooks that
// read and share it are tested in mod/tests/ready.test.ts.
//
//   pnpm test:file test/idle-ready.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { afterRead, COUNT_MS, due, type Entry, markText, parseEntry, READ_MS, readyIds } from "../mod/hooks/idle.ts";

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const row = (id: string | number, blockedOn: string[] = []) => ({ id, title: "T", updated: null, blockedOn });
const entry = (ageMs: number, ids: string[], ok = true, triedMs = ageMs): Entry => ({ at: NOW - ageMs, ids, ok, tried: NOW - triedMs });

test("readyIds: the ids with no open blocker; output that is no list of tickets is undefined", () => {
  const table: [string, string, string[] | undefined][] = [
    ["blocked and unblocked", JSON.stringify([row("1"), row("2", ["#1"]), row("3"), row("4", ["#1", "#2"])]), ["1", "3"]],
    ["numeric ids", JSON.stringify([row(7), row(8, ["#7"])]), ["7"]],
    ["ticket files", JSON.stringify([row("checkout-01"), row("checkout-02", ["checkout-01"])]), ["checkout-01"]],
    ["only blocked", JSON.stringify([row("1", ["#9"])]), []],
    ["an empty list", "[]", []],
    ["an empty read", "", undefined],
    ["not JSON", "gh: not signed in", undefined],
    ["an object", '{"error":"nope"}', undefined],
    ["null", "null", undefined],
    ["a list of numbers", "[1,2]", undefined],
    ["a ticket with no blockedOn", JSON.stringify([{ id: "1" }]), undefined],
    ["a ticket with no id", JSON.stringify([{ blockedOn: [] }]), undefined],
    ["a ticket with an empty id", JSON.stringify([row("")]), undefined],
    ["a good ticket beside a bad one", JSON.stringify([row("1"), "x"]), undefined],
  ];
  for (const [what, stdout, ids] of table) assert.deepEqual(readyIds(stdout), ids, what);
});

test("due: no entry, a fresh one, one ten minutes old, and each trigger", () => {
  const table: [string, Entry | undefined, "run-ended" | "skill" | undefined, boolean][] = [
    ["no entry", undefined, undefined, true],
    ["a fresh entry", entry(1 * MIN, ["1"]), undefined, false],
    ["just under ten minutes", entry(READ_MS - 1, ["1"]), undefined, false],
    ["ten minutes old", entry(READ_MS, ["1"]), undefined, true],
    ["an old one", entry(3 * 60 * MIN, ["1"]), undefined, true],
    ["a run ended, entry fresh", entry(1 * MIN, ["1"]), "run-ended", true],
    ["the skill was used, entry fresh", entry(1 * MIN, ["1"]), "skill", true],
    ["a trigger and no entry", undefined, "skill", true],
    // A failed read is tried again after ten minutes, not at once: its good ids are older than that.
    ["a failed read a minute ago", entry(30 * MIN, ["1"], false, 1 * MIN), undefined, false],
    ["a failed read ten minutes ago", entry(30 * MIN, ["1"], false, READ_MS), undefined, true],
    ["an entry from the future", { at: NOW + MIN, ids: [], ok: true, tried: NOW + MIN }, undefined, true],
  ];
  for (const [what, e, trigger, want] of table) assert.equal(due(e, NOW, trigger), want, what);
});

test("markText: no count at 0 ready, the count at N, and the last good count only while under an hour old", () => {
  const set = { setUp: true, idleMark: true, now: NOW };
  const ready = (n: number) => `sandcastle · ${n} ready - /sandcastle run`;
  const table: [string, Parameters<typeof markText>[0], string | undefined][] = [
    ["no read yet", { ...set }, "sandcastle"],
    ["0 ready", { ...set, entry: entry(MIN, []) }, "sandcastle"],
    ["1 ready", { ...set, entry: entry(MIN, ["1"]) }, ready(1)],
    ["4 ready", { ...set, entry: entry(MIN, ["1", "2", "3", "4"]) }, ready(4)],
    ["a failed read, the good count 20 minutes old", { ...set, entry: entry(20 * MIN, ["1", "2"], false, MIN) }, ready(2)],
    ["a failed read, just under an hour", { ...set, entry: entry(COUNT_MS - 1, ["1", "2"], false, MIN) }, ready(2)],
    ["a count an hour old", { ...set, entry: entry(COUNT_MS, ["1", "2"], false, MIN) }, "sandcastle"],
    ["a count over an hour old, the read ok", { ...set, entry: entry(2 * COUNT_MS, ["1", "2"]) }, "sandcastle"],
    ["a first read that failed", { ...set, entry: afterRead(undefined, undefined, NOW) }, "sandcastle"],
    ["an entry with no time to judge it by", { setUp: true, idleMark: true, entry: entry(MIN, ["1"]) }, "sandcastle"],
    ["not set up", { ...set, setUp: false, entry: entry(MIN, ["1"]) }, undefined],
    ["the machine switch off", { ...set, idleMark: false, entry: entry(MIN, ["1"]) }, undefined],
  ];
  for (const [what, input, text] of table) assert.equal(markText(input), text, what);
});

test("afterRead: a good read replaces the entry; a failed one keeps the last good ids and their time", () => {
  const good = entry(20 * MIN, ["1", "2"]);
  assert.deepEqual(afterRead(good, ["5"], NOW), { at: NOW, ids: ["5"], ok: true, tried: NOW });
  assert.deepEqual(afterRead(good, [], NOW), { at: NOW, ids: [], ok: true, tried: NOW });
  assert.deepEqual(afterRead(good, undefined, NOW), { at: good.at, ids: ["1", "2"], ok: false, tried: NOW });
  assert.deepEqual(afterRead(undefined, undefined, NOW), { at: NOW, ids: [], ok: false, tried: NOW });
});

test("parseEntry: only a whole entry is one, since the store is shared", () => {
  const good = entry(MIN, ["1"]);
  assert.deepEqual(parseEntry(JSON.parse(JSON.stringify(good))), good);
  for (const bad of [undefined, null, 3, "x", [], {}, { ...good, ids: "1" }, { ...good, ids: [1] }, { ...good, at: "now" }, { ...good, ok: 1 }, { ...good, tried: null }, { ...good, at: NaN }]) {
    assert.equal(parseEntry(bad), undefined, JSON.stringify(bad));
  }
});
