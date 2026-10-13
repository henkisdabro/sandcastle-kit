// The idle mark with the kit's version facts (mod/hooks/idle.ts), pure: the version in the name, the
// `update needed` and `project on X` hints and their colours, the ready count beside each, and the
// report's version lines. No Claude Code needed; the hooks that read the facts are tested in mod/tests/.
//
//   pnpm test:file test/idle-mark-version.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { afterVersionRead, COUNT_MS, type Entry, markReport, markText, parseVersionEntry, parseVersionFacts, type VersionEntry, type VersionFacts } from "../mod/hooks/idle.ts";

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const ready = (n: number, ageMin = 1): Entry => ({ at: NOW - ageMin * MIN, ids: Array.from({ length: n }, (_, i) => String(i + 1)), ok: true, tried: NOW - ageMin * MIN });
const facts = (kit: Partial<VersionFacts["kit"]>, project: VersionFacts["project"]): VersionFacts => ({ kit: { version: "0.17.0", release: "0.17.0", past: 0, ...kit }, newestRelease: null, project });
const read = (f: VersionFacts, ageMin = 1): VersionEntry => ({ at: NOW - ageMin * MIN, facts: f, ok: true, tried: NOW - ageMin * MIN });
const mark = (extra: object) => markText({ setUp: true, idleMark: true, now: NOW, ...extra });
const text = (extra: object) => mark(extra)?.text;

const SETTLED = { recorded: true, release: "0.17.0", pendingNotes: [] };

test("up to date: the kit's release in the name, the ready count and the call to run beside it", () => {
  const versionRead = read(facts({ release: "0.16.0", version: "0.16.0" }, { ...SETTLED, release: "0.16.0" }));
  assert.equal(text({ versionRead, entry: ready(16) }), "sandcastle 0.16.0 · 16 ready - /sandcastle run");
  assert.equal(text({ versionRead }), "sandcastle 0.16.0");
  assert.equal(text({ versionRead, entry: ready(0) }), "sandcastle 0.16.0");
});

test("a project outside any record (not set up for the CLI's cwd) shows the version alone", () => {
  assert.equal(text({ versionRead: read(facts({}, null)), entry: ready(3) }), "sandcastle 0.17.0 · 3 ready - /sandcastle run");
});

test("update needed: Upgrading notes not had, no record, or an unreadable record - the call to action is /sandcastle update", () => {
  for (const project of [
    { recorded: true, release: "0.17.0", pendingNotes: ["A new default."] },
    { recorded: false, release: null, pendingNotes: [] },
    { recorded: false, release: null, pendingNotes: ["A", "B"] },
  ]) {
    const versionRead = read(facts({}, project));
    assert.equal(text({ versionRead, entry: ready(16) }), "sandcastle 0.17.0 · 16 ready · update needed - /sandcastle update", JSON.stringify(project));
    assert.equal(text({ versionRead }), "sandcastle 0.17.0 · update needed - /sandcastle update", JSON.stringify(project));
  }
});

test("update needed beats project on X: notes pending on a project recorded at an older release", () => {
  const versionRead = read(facts({}, { recorded: true, release: "0.16.0", pendingNotes: ["A"] }));
  assert.equal(text({ versionRead, entry: ready(2) }), "sandcastle 0.17.0 · 2 ready · update needed - /sandcastle update");
});

test("project on X: a recorded release older than the kit's with nothing pending; the call to action stays run, and none with no ready ticket", () => {
  const versionRead = read(facts({}, { recorded: true, release: "0.16.0", pendingNotes: [] }));
  assert.equal(text({ versionRead, entry: ready(16) }), "sandcastle 0.17.0 · 16 ready · project on 0.16.0 - /sandcastle run");
  assert.equal(text({ versionRead }), "sandcastle 0.17.0 · project on 0.16.0");
  assert.equal(text({ versionRead, entry: ready(0) }), "sandcastle 0.17.0 · project on 0.16.0");
});

test("releases are compared as numbers: 0.10.0 is newer than 0.9.0, never older", () => {
  const behind = read(facts({ release: "0.10.0", version: "0.10.0" }, { recorded: true, release: "0.9.0", pendingNotes: [] }));
  assert.equal(text({ versionRead: behind }), "sandcastle 0.10.0 · project on 0.9.0");
  // The other way round (a project recorded past the kit: an older kit checkout) is not "behind".
  const ahead = read(facts({ release: "0.9.0", version: "0.9.0" }, { recorded: true, release: "0.10.0", pendingNotes: [] }));
  assert.equal(text({ versionRead: ahead }), "sandcastle 0.9.0");
  const same = read(facts({}, SETTLED));
  assert.equal(text({ versionRead: same }), "sandcastle 0.17.0");
  // A record that is no release says nothing rather than a wrong thing.
  assert.equal(text({ versionRead: read(facts({}, { recorded: true, release: "banana", pendingNotes: [] })) }), "sandcastle 0.17.0");
});

test("a clone past its release tag shows +N after the release, with the commit and local changes left to the report", () => {
  const versionRead = read(facts({ release: "0.16.0", version: "0.16.0 +3 (1c4f46f, local changes)", past: 3 }, { ...SETTLED, release: "0.16.0" }));
  assert.equal(text({ versionRead, entry: ready(16) }), "sandcastle 0.16.0+3 · 16 ready - /sandcastle run");
  assert.equal(text({ versionRead }), "sandcastle 0.16.0+3");
});

test("the ready count's dismissal and staleness leave each hint and the version as they were", () => {
  const needed = read(facts({}, { recorded: false, release: null, pendingNotes: [] }));
  const behind = read(facts({}, { recorded: true, release: "0.16.0", pendingNotes: [] }));
  const dismissed = { dismissed: ["1", "2"], entry: ready(2) };
  assert.equal(text({ versionRead: needed, ...dismissed }), "sandcastle 0.17.0 · update needed - /sandcastle update");
  assert.equal(text({ versionRead: behind, ...dismissed }), "sandcastle 0.17.0 · project on 0.16.0");
  const stale = { entry: ready(2, COUNT_MS / MIN + 1) };
  assert.equal(text({ versionRead: needed, ...stale }), "sandcastle 0.17.0 · update needed - /sandcastle update");
  assert.equal(text({ versionRead: behind, ...stale }), "sandcastle 0.17.0 · project on 0.16.0");
});

test("hidden clears the line whatever the facts say", () => {
  const versionRead = read(facts({}, { recorded: false, release: null, pendingNotes: [] }));
  assert.equal(mark({ versionRead, hidden: true }), undefined);
  assert.equal(mark({ versionRead, idleMark: false }), undefined);
  assert.equal(mark({ versionRead, setUp: false }), undefined);
});

test("facts older than an hour are not shown: the mark stands without a version, as without a count", () => {
  const versionRead = read(facts({}, { recorded: false, release: null, pendingNotes: [] }), COUNT_MS / MIN + 1);
  assert.equal(text({ versionRead, entry: ready(2) }), "sandcastle · 2 ready - /sandcastle run");
  assert.equal(text({ versionRead: { ...versionRead, facts: null } }), "sandcastle");
  assert.equal(text({}), "sandcastle");
});

test("the parts of the line: the hint bold-bright, project on X muted, the rest the row's sand, and they spell the plain text", () => {
  const needed = mark({ versionRead: read(facts({}, { recorded: false, release: null, pendingNotes: [] })), entry: ready(16) })!;
  assert.deepEqual(needed.parts, [
    { text: "sandcastle 0.17.0 · 16 ready ·", tone: "name" },
    { text: "update needed", tone: "hint" },
    { text: "- /sandcastle update", tone: "name" },
  ]);
  const behind = mark({ versionRead: read(facts({}, { recorded: true, release: "0.16.0", pendingNotes: [] })), entry: ready(16) })!;
  assert.deepEqual(behind.parts, [
    { text: "sandcastle 0.17.0 · 16 ready ·", tone: "name" },
    { text: "project on 0.16.0", tone: "muted" },
    { text: "- /sandcastle run", tone: "name" },
  ]);
  const plain = mark({ versionRead: read(facts({}, SETTLED)), entry: ready(16) })!;
  assert.deepEqual(plain.parts, [{ text: "sandcastle 0.17.0 · 16 ready - /sandcastle run", tone: "name" }]);
  for (const m of [needed, behind, plain]) assert.equal(m.parts.map((p) => p.text).join(" "), m.text);
});

test("the report names the full kit version, the recorded release and the pending notes, or that none are held", () => {
  const base = { setUp: true, idleMark: true, now: NOW };
  assert.match(markReport({ ...base }), /\nKit version: not read yet\.$/);
  const pending = markReport({ ...base, versionRead: read(facts({ version: "0.17.0 +3 (1c4f46f, local changes)", past: 3 }, { recorded: true, release: "0.16.0", pendingNotes: ["A new default.", "A rebuild."] }), 4) });
  assert.match(pending, /\nKit version: 0\.17\.0 \+3 \(1c4f46f, local changes\), read 4 min ago\.\nProject's recorded release: 0\.16\.0\.\nPending Upgrading notes:\n {2}- A new default\.\n {2}- A rebuild\.$/);
  const none = markReport({ ...base, versionRead: read(facts({}, SETTLED), 4) });
  assert.match(none, /\nProject's recorded release: 0\.17\.0\.\nPending Upgrading notes: none held\.$/);
  assert.match(markReport({ ...base, versionRead: read(facts({}, { recorded: false, release: null, pendingNotes: [] })) }), /\nProject's recorded release: none \(no usable update record on this machine\)\./);
  assert.match(markReport({ ...base, versionRead: read(facts({}, { recorded: true, release: null, pendingNotes: [] })) }), /\nProject's recorded release: none named by the record\./);
  // Held facts are told even while the mark is hidden, and past the hour they are marked too old to show.
  assert.match(markReport({ ...base, hidden: true, versionRead: read(facts({}, SETTLED), 90) }), /^Idle mark: hidden in this project[^]*\nKit version: 0\.17\.0, read 1 h 30 min ago; too old to show\./);
});

test("parseVersionFacts takes what --version --json prints, and nothing else", () => {
  const good = { kit: { version: "0.16.0 +3 (1c4f46f)", release: "0.16.0", past: 3 }, newestRelease: null, project: { recorded: true, release: "0.16.0", pendingNotes: ["x"] } };
  assert.deepEqual(parseVersionFacts(JSON.stringify(good)), good);
  assert.deepEqual(parseVersionFacts(JSON.stringify({ ...good, project: null }))?.project, null);
  assert.deepEqual(parseVersionFacts(JSON.stringify({ ...good, project: { ...good.project, release: null } }))?.project?.release, null);
  const withNewest = { ...good, newestRelease: { release: "0.17.0", checkedAt: "2026-10-13T05:12:00Z" } };
  assert.deepEqual(parseVersionFacts(JSON.stringify(withNewest)), withNewest);
  for (const bad of ["", "not json", "null", "[]", "{}", JSON.stringify({ ...good, kit: { release: "0.16.0" } }), JSON.stringify({ ...good, project: { recorded: "yes", release: null, pendingNotes: [] } }), JSON.stringify({ ...good, project: { ...good.project, pendingNotes: [1] } }), JSON.stringify({ ...good, newestRelease: "0.17.0" })]) {
    assert.equal(parseVersionFacts(bad), undefined, bad);
  }
});

test("a failed version read keeps the last good facts and their time, and parseVersionEntry checks the shared store", () => {
  const good = facts({}, SETTLED);
  const first = afterVersionRead(undefined, good, NOW);
  assert.deepEqual(first, { at: NOW, facts: good, ok: true, tried: NOW });
  assert.deepEqual(afterVersionRead(first, undefined, NOW + 5 * MIN), { at: NOW, facts: good, ok: false, tried: NOW + 5 * MIN });
  assert.deepEqual(afterVersionRead(undefined, undefined, NOW), { at: NOW, facts: null, ok: false, tried: NOW });
  assert.deepEqual(parseVersionEntry(first), first);
  assert.deepEqual(parseVersionEntry({ at: NOW, facts: null, ok: false, tried: NOW }), { at: NOW, facts: null, ok: false, tried: NOW });
  for (const bad of [undefined, null, "x", {}, { at: NOW, facts: { kit: 1 }, ok: true, tried: NOW }, { at: "1", facts: null, ok: true, tried: NOW }, { at: NOW, facts: null, ok: "yes", tried: NOW }]) {
    assert.equal(parseVersionEntry(bad), undefined, JSON.stringify(bad));
  }
});
