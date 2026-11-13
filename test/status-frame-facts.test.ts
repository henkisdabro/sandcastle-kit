// `sandcastle status --json --frame`: the frame's facts besides the ticket table (the castle, the title, the lanes
// and the legend, src/status-frame.ts) as plain data, held to the frame the terminal draws. Each test starts the
// view's entry as a child process over a status fixture (no Docker, no network): once for the JSON, once for the
// frame drawn at 180 columns with its colour codes stripped, and the two are compared by what they say.
//
//   pnpm test:file test/status-frame-facts.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { palette } from "../src/status-render.ts";
import { buildFixture, type FixtureKind } from "./status-fixture.ts";
import { drawFrame, spawnStatus, viewEnv } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-frame-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

type Segment = { text: string; tone: string; bold?: true };
type Frame = {
  logo: Segment[][];
  title: { wordmark: string; name: string; base: string; unpushed: number; clock: string; version?: string; rows: Segment[][]; compact: Segment[] };
  lanes: { name: string; title: Segment; rows: Segment[][] }[];
  legend: { groups: { name: string; count: number; segments: Segment[] }[]; notes: { column?: string; segments: Segment[] }[] };
};

const run = (fixture: ReturnType<typeof buildFixture>, args: string[]) => {
  const r = spawnStatus(args, { encoding: "utf8", env: viewEnv(fixture), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const joined = (row: Segment[]) => row.map((s) => s.text).join("");
/** Runs of white space as one space: a lane folded into the summary line keeps its words, not its padding. */
const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();
/** "sandcastle-kit" as the castle's title spells it: `s a n d c a s t l e - k i t`. */
const spaced = (wordmark: string) => wordmark.split("-").map((w) => [...w].join(" ")).join(" - ");

/** The fixture's facts and its frame at 180 columns, read once for the tests of a kind. */
const read = (kind: FixtureKind) => {
  const fixture = buildFixture(kind, mkdtempSync(join(TMP, `${kind}-`)));
  try {
    const stdout = run(fixture, ["--json", "--frame"]);
    const plainJson = run(fixture, ["--json"]);
    const drawn = drawFrame(fixture, { cols: 180 });
    assert.equal(drawn.status, 0, drawn.stderr);
    return { stdout, doc: JSON.parse(stdout) as { table: unknown; frame: Frame }, plainJson, frame: drawn.frame, lines: drawn.frame.split("\n").map(squeeze) };
  } finally {
    fixture.stop();
  }
};

for (const kind of ["live", "legacy", "ended"] as FixtureKind[]) {
  const got = read(kind);
  const { frame } = got.doc;
  const inFrame = (what: string) => got.lines.some((l) => l.includes(squeeze(what)));
  // A lane folded into the summary line is cut with "…" where the pane ends (at 180 columns the live fixture's plan
  // is): its first row is then in the frame as far as the cut, and a later row may lie wholly beyond it.
  const inFrameOrCut = (what: string, lane: string, first: boolean) => {
    const w = squeeze(what);
    if (inFrame(w)) return true;
    const cutLine = got.lines.find((l) => l.includes(`${lane.toLowerCase()} `) && l.endsWith("… │"));
    if (!cutLine) return false;
    if (!first) return true;
    for (let n = w.length - 1; n >= Math.ceil(w.length / 2); n--) if (cutLine.includes(`${w.slice(0, n)}…`)) return true;
    return false;
  };

  test(`status --json --frame of the ${kind} fixture is { table, frame }, and its table is the plain --json document`, () => {
    assert.ok(!got.stdout.includes("\u001b"), "an escape sequence in the JSON");
    assert.ok(got.stdout.endsWith("\n") && got.stdout.trim().split("\n").length === 1, "not one line of JSON and a newline");
    assert.deepEqual(Object.keys(got.doc).sort(), ["frame", "table"]);
    assert.deepEqual(got.doc.table, JSON.parse(got.plainJson));
    assert.deepEqual(Object.keys(JSON.parse(got.plainJson)).sort(), ["counts", "later", "partly", "rows"]);
  });

  test(`the ${kind} fixture's lane rows are in the frame the terminal draws`, () => {
    assert.ok(frame.lanes.length >= 2 && frame.lanes[0]!.name === "RUN" && frame.lanes[1]!.name === "MACHINE");
    for (const lane of frame.lanes) {
      assert.equal(joined([lane.title]), lane.name);
      assert.deepEqual(lane.title.bold, true, `${lane.name}: the lane title is bold`);
      const rows = lane.rows.map(joined).filter((r) => squeeze(r) !== "");
      assert.ok(rows.length > 0, `${lane.name} has no row`);
      rows.forEach((r, i) => assert.ok(inFrameOrCut(r, lane.name, i === 0), `${lane.name}: "${squeeze(r)}" is not in the frame:\n${got.frame}`));
    }
    // Every lane the frame draws is a lane of the facts, none more: its name is in the frame as a title or on the summary line.
    for (const name of ["RUN", "MACHINE", "MODELS", "SETTINGS", "PLAN"]) {
      const drawn = got.lines.some((l) => l.includes(` ${name} `) || l.includes(`${name.toLowerCase()} `));
      assert.equal(frame.lanes.some((l) => l.name === name), drawn, `${name}: in the facts and in the frame must agree`);
    }
  });

  test(`the ${kind} fixture's title fields, one by one, are in the frame`, () => {
    const t = frame.title;
    assert.equal(t.wordmark, "sandcastle-kit");
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.base, "string");
    assert.equal(typeof t.unpushed, "number");
    assert.match(t.clock, /^\d\d:\d\d:\d\d$/);
    if (t.version !== undefined) assert.doesNotMatch(t.version, /^v/);
    assert.ok(inFrame(spaced(t.wordmark)), "the wordmark");
    assert.ok(inFrame(t.name), "the project's name");
    assert.ok(inFrame(`base ${t.base}`), "the base");
    assert.ok(inFrame(t.clock), "the clock");
    assert.equal(inFrame(`↑${t.unpushed} unpushed`), t.unpushed > 0, "the unpushed count shows when there is one");
    assert.equal(inFrame(`v${t.version}`), t.version !== undefined, "the version shows when it is known");
    // The compact form is the same facts on one row.
    const compact = joined(t.compact);
    for (const field of [t.wordmark, t.name, `base ${t.base}`, t.clock]) assert.ok(compact.includes(field), `compact: ${field}`);
    // The wordmark is bold and coloured at once.
    const mark = t.rows[0]!.find((s) => s.text === "s a n d c a s t l e");
    assert.deepEqual(mark && { tone: mark.tone, bold: mark.bold }, { tone: "moon", bold: true });
  });

  test(`the ${kind} fixture's logo is the castle the frame draws, with none of the title`, () => {
    assert.equal(frame.logo.length, 3);
    for (const row of frame.logo) assert.ok(inFrame(joined(row)), `castle row "${joined(row)}" is not in the frame`);
    // Each castle row with its title row beside it is one cell of the frame: the castle the terminal draws, row by row.
    frame.logo.forEach((row, i) => {
      const beside = joined([...row, ...frame.title.rows[i]!]);
      assert.ok(inFrame(beside), `castle row ${i + 1} with its title, "${squeeze(beside)}", is not in the frame:\n${got.frame}`);
    });
    const castle = frame.logo.map(joined).join("\n");
    assert.match(castle, /▄ ▄ ▄/);
    assert.match(castle, /█████/);
    assert.match(castle, /██▀██/);
    assert.ok(!castle.includes(frame.title.name) && !castle.includes(frame.title.wordmark) && !castle.includes(spaced(frame.title.wordmark)), "title text in the logo");
  });

  test(`the ${kind} fixture's legend counts and notes are in the frame`, () => {
    const counts = (got.doc.table as { counts: Record<string, number> }).counts;
    for (const g of frame.legend.groups) {
      assert.equal(g.count, counts[g.name], `count of ${g.name}`);
      assert.ok(inFrame(joined(g.segments)), `"${joined(g.segments)}" is not in the frame`);
      const count = g.segments.find((s) => s.text === String(g.count));
      assert.ok(count?.bold === true && count.tone !== "plain", `${g.name}: the count is bold and coloured`);
    }
    // Both width-dependent notes are always given, each naming its column; the terminal shows one with its column.
    const columns = frame.legend.notes.flatMap((n) => (n.column ? [n.column] : []));
    assert.deepEqual(columns.sort(), ["CPU/MEM", "TOKENS"]);
    for (const n of frame.legend.notes) {
      const shown = n.column ? got.lines.some((l) => l.includes(n.column!) && !l.includes(joined(n.segments))) : true;
      assert.ok(shown);
      assert.ok(inFrame(joined(n.segments)), `note "${joined(n.segments)}" is not in the frame at 180 columns`);
    }
  });

  test(`the ${kind} fixture's segments name tones of the view's palette`, () => {
    const known = new Set([...Object.keys(palette(true, true)), "plain"]);
    const all: Segment[] = [...frame.logo.flat(), ...frame.title.rows.flat(), ...frame.title.compact, ...frame.lanes.flatMap((l) => [l.title, ...l.rows.flat()]), ...frame.legend.groups.flatMap((g) => g.segments), ...frame.legend.notes.flatMap((n) => n.segments)];
    for (const s of all) {
      assert.ok(known.has(s.tone), `unknown tone ${s.tone}`);
      assert.ok(s.text !== "", "an empty segment");
      assert.ok(s.bold === undefined || s.bold === true);
    }
  });
}

test("the ended fixture's lanes are RUN, MACHINE, MODELS and SETTINGS: no PLAN", () => {
  const ended = read("ended").doc.frame;
  assert.ok(!ended.lanes.some((l) => l.name === "PLAN"), "an ended run has no plan lane");
  assert.deepEqual(
    ended.lanes.map((l) => l.name),
    ["RUN", "MACHINE", "MODELS", "SETTINGS"],
  );
});

test("status --json without --frame stays the bare table", () => {
  const fixture = buildFixture("live", mkdtempSync(join(TMP, "bare-")));
  try {
    assert.deepEqual(Object.keys(JSON.parse(run(fixture, ["--json"]))).sort(), ["counts", "later", "partly", "rows"]);
    assert.deepEqual(Object.keys(JSON.parse(run(fixture, ["--frame", "--json"]))).sort(), ["frame", "table"]);
  } finally {
    fixture.stop();
  }
});
