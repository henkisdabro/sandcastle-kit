// The idle mark with the kit's version facts (mod/hooks/idle.ts), pure: the version in the name, the
// `N out` and `update needed` hints and their colours, the project's recorded release never shown, the ready count beside each, and the
// report's version lines. No Claude Code needed; the hooks that read the facts are tested in mod/tests/.
//
//   pnpm test:file test/idle-mark-version.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { afterVersionRead, COUNT_MS, type Entry, markReport, markText, parseVersionEntry, parseVersionFacts, type VersionEntry, type VersionFacts } from "../mod/hooks/idle.ts";

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const ready = (n: number, ageMin = 1): Entry => ({ at: NOW - ageMin * MIN, ids: Array.from({ length: n }, (_, i) => String(i + 1)), ok: true, tried: NOW - ageMin * MIN });
const facts = (kit: Partial<VersionFacts["kit"]>, project: VersionFacts["project"], newest?: string): VersionFacts => ({
  kit: { version: "0.17.0", release: "0.17.0", past: 0, ...kit },
  newestRelease: newest ? { release: newest, checkedAt: new Date(NOW - 5 * MIN).toISOString() } : null,
  project,
});
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

test("the mark never shows the project's release: older with nothing pending says nothing, with notes pending says update needed", () => {
  const older = read(facts({}, { recorded: true, release: "0.16.0", pendingNotes: [] }));
  assert.equal(text({ versionRead: older, entry: ready(16) }), "sandcastle 0.17.0 · 16 ready - /sandcastle run");
  assert.equal(text({ versionRead: older }), "sandcastle 0.17.0");
  assert.equal(text({ versionRead: older, entry: ready(0) }), "sandcastle 0.17.0");
  const pending = read(facts({}, { recorded: true, release: "0.16.0", pendingNotes: ["A"] }));
  assert.equal(text({ versionRead: pending, entry: ready(2) }), "sandcastle 0.17.0 · 2 ready · update needed - /sandcastle update");
  for (const release of ["0.16.0", "0.17.0", "0.9.0", "banana", null]) {
    for (const entry of [undefined, ready(3)]) assert.doesNotMatch(text({ versionRead: read(facts({}, { recorded: true, release, pendingNotes: [] })), entry }) ?? "", /project on/);
  }
});

test("N out: a newer release on the remote, over update needed, with the call to update", () => {
  const settled = read(facts({ release: "0.16.0", version: "0.16.0" }, { ...SETTLED, release: "0.16.0" }, "0.17.0"));
  assert.equal(text({ versionRead: settled, entry: ready(16) }), "sandcastle 0.16.0 · 16 ready · 0.17.0 out - /sandcastle update");
  assert.equal(text({ versionRead: settled }), "sandcastle 0.16.0 · 0.17.0 out - /sandcastle update");
  // Above update needed: notes pending, or no record, and the mark still names the release.
  const needed = read(facts({ release: "0.16.0", version: "0.16.0" }, { recorded: false, release: null, pendingNotes: ["A"] }, "0.17.0"));
  assert.equal(text({ versionRead: needed, entry: ready(2) }), "sandcastle 0.16.0 · 2 ready · 0.17.0 out - /sandcastle update");
  // Outside a set-up project's facts (project null) the release is still out.
  assert.equal(text({ versionRead: read(facts({ release: "0.16.0" }, null, "0.17.0")) }), "sandcastle 0.16.0 · 0.17.0 out - /sandcastle update");
});

test("N out compares releases as numbers and only when the remote's is newer than the kit's", () => {
  assert.equal(text({ versionRead: read(facts({ release: "0.9.0", version: "0.9.0" }, SETTLED, "0.10.0")) }), "sandcastle 0.9.0 · 0.10.0 out - /sandcastle update");
  for (const [kit, newest] of [["0.17.0", "0.17.0"], ["0.10.0", "0.9.0"], ["0.17.0", "0.16.0"]] as const) {
    assert.equal(text({ versionRead: read(facts({ release: kit, version: kit }, SETTLED, newest)) }), `sandcastle ${kit}`, `${kit} against ${newest}`);
  }
  // A newest release that is no X.Y.Z says nothing rather than a wrong thing.
  assert.equal(text({ versionRead: read(facts({}, SETTLED, "banana")) }), "sandcastle 0.17.0");
  // Not known (null): nothing, and update needed still stands alone.
  assert.equal(text({ versionRead: read(facts({}, SETTLED)) }), "sandcastle 0.17.0");
  assert.equal(text({ versionRead: read(facts({}, { recorded: false, release: null, pendingNotes: [] })) }), "sandcastle 0.17.0 · update needed - /sandcastle update");
});

test("a clone past its tag: a newer release is out, the same release or none is not", () => {
  const past = { release: "0.16.0", version: "0.16.0 +3 (1c4f46f)", past: 3 };
  assert.equal(text({ versionRead: read(facts(past, { ...SETTLED, release: "0.16.0" }, "0.17.0")), entry: ready(2) }), "sandcastle 0.16.0+3 · 2 ready · 0.17.0 out - /sandcastle update");
  assert.equal(text({ versionRead: read(facts(past, { ...SETTLED, release: "0.16.0" }, "0.16.0")), entry: ready(2) }), "sandcastle 0.16.0+3 · 2 ready - /sandcastle run");
  assert.equal(text({ versionRead: read(facts(past, { ...SETTLED, release: "0.16.0" })), entry: ready(2) }), "sandcastle 0.16.0+3 · 2 ready - /sandcastle run");
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
  assert.equal(text({ versionRead: behind, ...dismissed }), "sandcastle 0.17.0");
  const out = read(facts({}, SETTLED, "0.18.0"));
  assert.equal(text({ versionRead: out, ...dismissed }), "sandcastle 0.17.0 · 0.18.0 out - /sandcastle update");
  const stale = { entry: ready(2, COUNT_MS / MIN + 1) };
  assert.equal(text({ versionRead: needed, ...stale }), "sandcastle 0.17.0 · update needed - /sandcastle update");
  assert.equal(text({ versionRead: behind, ...stale }), "sandcastle 0.17.0");
  assert.equal(text({ versionRead: out, ...stale }), "sandcastle 0.17.0 · 0.18.0 out - /sandcastle update");
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

test("the parts of the line: the hint bold-bright, the rest the row's sand, and they spell the plain text", () => {
  const needed = mark({ versionRead: read(facts({}, { recorded: false, release: null, pendingNotes: [] })), entry: ready(16) })!;
  assert.deepEqual(needed.parts, [
    { text: "sandcastle 0.17.0 · 16 ready ·", tone: "name" },
    { text: "update needed", tone: "hint" },
    { text: "- /sandcastle update", tone: "name" },
  ]);
  const out = mark({ versionRead: read(facts({}, SETTLED, "0.18.0")), entry: ready(16) })!;
  assert.deepEqual(out.parts, [
    { text: "sandcastle 0.17.0 · 16 ready ·", tone: "name" },
    { text: "0.18.0 out", tone: "hint" },
    { text: "- /sandcastle update", tone: "name" },
  ]);
  const plain = mark({ versionRead: read(facts({}, SETTLED)), entry: ready(16) })!;
  assert.deepEqual(plain.parts, [{ text: "sandcastle 0.17.0 · 16 ready - /sandcastle run", tone: "name" }]);
  for (const m of [needed, out, plain]) assert.equal(m.parts.map((p) => p.text).join(" "), m.text);
});

test("the report names the full kit version, the recorded release and the pending notes, or that none are held", () => {
  const base = { setUp: true, idleMark: true, now: NOW };
  assert.match(markReport({ ...base }), /\nKit version: not read yet\.$/);
  const pending = markReport({ ...base, versionRead: read(facts({ version: "0.17.0 +3 (1c4f46f, local changes)", past: 3 }, { recorded: true, release: "0.16.0", pendingNotes: ["A new default.", "A rebuild."] }), 4) });
  assert.match(pending, /\nKit version: 0\.17\.0 \+3 \(1c4f46f, local changes\), read 4 min ago\.\nProject's recorded release: 0\.16\.0\.\nPending Upgrading notes:\n {2}- A new default\.\n {2}- A rebuild\.\nNewest release: not known /);
  const none = markReport({ ...base, versionRead: read(facts({}, SETTLED), 4) });
  assert.match(none, /\nProject's recorded release: 0\.17\.0\.\nPending Upgrading notes: none held\.\nNewest release: not known /);
  assert.match(markReport({ ...base, versionRead: read(facts({}, { recorded: false, release: null, pendingNotes: [] })) }), /\nProject's recorded release: none \(no usable update record on this machine\)\./);
  assert.match(markReport({ ...base, versionRead: read(facts({}, { recorded: true, release: null, pendingNotes: [] })) }), /\nProject's recorded release: none named by the record\./);
  // Held facts are told even while the mark is hidden, and past the hour they are marked too old to show.
  assert.match(markReport({ ...base, hidden: true, versionRead: read(facts({}, SETTLED), 90) }), /^Idle mark: hidden in this project[^]*\nKit version: 0\.17\.0, read 1 h 30 min ago; too old to show\./);
});

test("the report names the newest release and when it was checked, or that it is not known", () => {
  const base = { setUp: true, idleMark: true, now: NOW };
  const known = markReport({ ...base, versionRead: read(facts({}, SETTLED, "0.18.0")) });
  assert.match(known, /\nNewest release: 0\.18\.0, checked 5 min ago\.$/);
  // Told even while the mark is hidden, as the other held facts are.
  assert.match(markReport({ ...base, hidden: true, versionRead: read(facts({}, SETTLED, "0.18.0")) }), /\nNewest release: 0\.18\.0, checked 5 min ago\.$/);
  assert.match(markReport({ ...base, versionRead: read(facts({}, SETTLED)) }), /\nNewest release: not known \(the check is off, the remote did not answer or it has no release tag\)\.$/);
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
