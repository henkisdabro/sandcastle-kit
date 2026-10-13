// The idle mark's release dismissal (mod/hooks/idle.ts), pure: `/sandcastle-mark dismiss` also quiets
// `N out` until a newer release is tagged, apart from the dismissed ready ids. No Claude Code needed;
// the command is tested in mod/tests/mark-release.test.ts.
//
//   pnpm test:file test/idle-mark-release-dismissal.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceAfter, type Entry, markReport, markText, parseChoice, type VersionEntry, type VersionFacts } from "../mod/hooks/idle.ts";

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const ready = (ids: string[]): Entry => ({ at: NOW - MIN, ids, ok: true, tried: NOW - MIN });
const versions = (newest: string | null, pendingNotes: string[] = [], ageMin = 1): VersionEntry => {
  const facts: VersionFacts = {
    kit: { version: "0.17.0", release: "0.17.0", past: 0 },
    newestRelease: newest ? { release: newest, checkedAt: new Date(NOW - 5 * MIN).toISOString() } : null,
    project: { recorded: true, release: "0.17.0", pendingNotes },
  };
  return { at: NOW - ageMin * MIN, facts, ok: true, tried: NOW - ageMin * MIN };
};
const text = (extra: object) => markText({ setUp: true, idleMark: true, now: NOW, ...extra })?.text;

test("a dismissed release stays quiet until a newer one is tagged, then shows again", () => {
  const base = { entry: ready([]), dismissedRelease: "0.18.0" };
  assert.equal(text({ ...base, versionRead: versions("0.18.0") }), "sandcastle 0.17.0");
  assert.equal(text({ ...base, versionRead: versions("0.18.1") }), "sandcastle 0.17.0 · 0.18.1 out - /sandcastle update");
  assert.equal(text({ ...base, versionRead: versions("0.19.0") }), "sandcastle 0.17.0 · 0.19.0 out - /sandcastle update");
  // Part by part as numbers: 0.18.0 is newer than a dismissed 0.9.0.
  assert.equal(text({ entry: ready([]), dismissedRelease: "0.9.0", versionRead: versions("0.18.0") }), "sandcastle 0.17.0 · 0.18.0 out - /sandcastle update");
  // Without a dismissal it shows.
  assert.equal(text({ entry: ready([]), versionRead: versions("0.18.0") }), "sandcastle 0.17.0 · 0.18.0 out - /sandcastle update");
});

test("a newly ready ticket does not bring back a dismissed release, and a newer release does not bring back a dismissed count", () => {
  const dismissedBoth = { dismissed: ["1", "2"], dismissedRelease: "0.18.0" };
  // A third ticket is ready: the count is back, the release stays quiet.
  assert.equal(text({ ...dismissedBoth, entry: ready(["1", "2", "3"]), versionRead: versions("0.18.0") }), "sandcastle 0.17.0 · 3 ready - /sandcastle run");
  // A newer release: the hint is back, the count stays quiet.
  assert.equal(text({ ...dismissedBoth, entry: ready(["1", "2"]), versionRead: versions("0.19.0") }), "sandcastle 0.17.0 · 0.19.0 out - /sandcastle update");
  // Neither: both quiet.
  assert.equal(text({ ...dismissedBoth, entry: ready(["1", "2"]), versionRead: versions("0.18.0") }), "sandcastle 0.17.0");
});

test("dismissing a newer release with Upgrading notes pending shows update needed", () => {
  const versionRead = versions("0.18.0", ["A new default."]);
  assert.equal(text({ entry: ready(["1"]), dismissedRelease: "0.18.0", versionRead }), "sandcastle 0.17.0 · 1 ready · update needed - /sandcastle update");
  assert.equal(text({ entry: ready([]), versionRead }), "sandcastle 0.17.0 · 0.18.0 out - /sandcastle update");
});

test("choiceAfter: dismiss records the release that is out and keeps the dismissed ids apart", () => {
  const entry = ready(["1", "2"]);
  assert.deepEqual(choiceAfter("dismiss", { hidden: false }, entry, NOW, versions("0.18.0")), { hidden: false, dismissed: ["1", "2"], dismissedRelease: "0.18.0" });
  // No release newer than the kit's own, a release read too old to show, or none read: no release is dismissed.
  assert.deepEqual(choiceAfter("dismiss", { hidden: false }, entry, NOW, versions("0.17.0")), { hidden: false, dismissed: ["1", "2"] });
  assert.deepEqual(choiceAfter("dismiss", { hidden: false }, entry, NOW, versions("0.18.0", [], 90)), { hidden: false, dismissed: ["1", "2"] });
  assert.deepEqual(choiceAfter("dismiss", { hidden: false }, entry, NOW, versions(null)), { hidden: false, dismissed: ["1", "2"] });
  assert.deepEqual(choiceAfter("dismiss", { hidden: false }, entry, NOW), { hidden: false, dismissed: ["1", "2"] });
  // An earlier dismissal stays when there is nothing new to record, and a newer release replaces it.
  assert.deepEqual(choiceAfter("dismiss", { hidden: false, dismissedRelease: "0.18.0" }, entry, NOW, versions(null)), { hidden: false, dismissed: ["1", "2"], dismissedRelease: "0.18.0" });
  assert.deepEqual(choiceAfter("dismiss", { hidden: false, dismissedRelease: "0.18.0" }, entry, NOW, versions("0.19.0")), { hidden: false, dismissed: ["1", "2"], dismissedRelease: "0.19.0" });
});

test("choiceAfter: hide keeps the dismissed release, show clears both", () => {
  const prior = { hidden: false, dismissed: ["1"], dismissedRelease: "0.18.0" };
  assert.deepEqual(choiceAfter("hide", prior, ready(["1"]), NOW), { hidden: true, dismissed: ["1"], dismissedRelease: "0.18.0" });
  assert.deepEqual(choiceAfter("show", { ...prior, hidden: true }, ready(["1"]), NOW), { hidden: false });
});

test("parseChoice: today's form still parses, and a dismissed release must be a release", () => {
  assert.deepEqual(parseChoice({ hidden: false, dismissed: ["1"] }), { hidden: false, dismissed: ["1"] });
  assert.deepEqual(parseChoice({ hidden: true }), { hidden: true });
  assert.deepEqual(parseChoice({ hidden: false, dismissedRelease: "0.18.0" }), { hidden: false, dismissedRelease: "0.18.0" });
  assert.deepEqual(parseChoice({ hidden: false, dismissed: [], dismissedRelease: "0.18.0" }), { hidden: false, dismissed: [], dismissedRelease: "0.18.0" });
  for (const bad of [{ hidden: false, dismissedRelease: 18 }, { hidden: false, dismissedRelease: "soon" }, { hidden: false, dismissedRelease: "" }]) {
    assert.equal(parseChoice(bad), undefined, JSON.stringify(bad));
  }
});

test("markReport says what is dismissed, and not a release a newer one has ended", () => {
  const base = { setUp: true, idleMark: true, now: NOW, entry: ready(["1"]) };
  assert.match(markReport({ ...base, dismissedRelease: "0.18.0", versionRead: versions("0.18.0") }), /^Idle mark: shown: release 0.18.0 dismissed until a newer one is tagged \(\/sandcastle-mark show ends it\)\./);
  assert.match(markReport({ ...base, dismissed: ["1"], dismissedRelease: "0.18.0", versionRead: versions("0.18.0") }), /^Idle mark: shown without a count: dismissed until a new ticket becomes ready, and release 0.18.0 dismissed until a newer one is tagged \(\/sandcastle-mark show ends both\)\./);
  assert.match(markReport({ ...base, dismissed: ["1"], dismissedRelease: "0.18.0", versionRead: versions("0.19.0") }), /^Idle mark: shown without a count: dismissed until a new ticket becomes ready \(\/sandcastle-mark show ends it\)\./);
  assert.match(markReport({ ...base, dismissedRelease: "0.18.0", versionRead: versions("0.19.0") }), /^Idle mark: shown\./);
});
