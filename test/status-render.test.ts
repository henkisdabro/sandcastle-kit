// The status view's layout (#695), drawn by the TypeScript renderer from a built snapshot at every width from 60 to
// 330 columns and several heights: no line wider than the pane, the logo whole, the lanes beside the logo while
// it and three of them fit (else under it), the rest on one summary line, and the table's columns at set widths
// with ACTIVITY taking the rest. The renderer is pure, so no process, no Docker, no network.
//
//   pnpm test:file test/status-render.test.ts

// The run's times are drawn in local time: one zone, so a frame is the same on every machine.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row, Table } from "../src/status-rows.ts";
import type { Snapshot } from "../src/status-snapshot.ts";

const { palette, renderFrame } = await import("../src/status-render.ts");
const { visibleWidth } = await import("../src/status-grid.ts");

const NOW = Date.UTC(2026, 9, 12, 13, 0, 0) / 1000;
const LONG_NOTE = "editing docs/DEPLOYMENT.md - removing the Pages deploy section, the rollback steps that named pages.dev and the API_WORKER paragraph";

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  shown: `#${id}`,
  state: "impl",
  glyph: "●",
  tone: "ylw",
  group: "working",
  time: "6m",
  timeTone: "head",
  diff: "+96 \u22121159",
  note: "working",
  noteTone: "head",
  prio: 0,
  key: 0,
  apart: false,
  ...over,
});

const tableOf = (rows: Row[]): Table => ({
  rows,
  counts: { working: 2, "needs you": 0, ready: 0, queued: 0, blocked: 1, merged: 0, later: 0, "left over": 0, idle: 0 },
  partly: 0,
  later: { ids: [], blocked: 0 },
});

const TABLE = tableOf([
  row("120", { note: LONG_NOTE, cpu: { cpu: "1.4c", mem: "2.1G", hot: false }, tokens: "2.5M/27k" }),
  row("269", { state: "gates", note: "test-unit running (api project serial, 14/22 files, retry 1)", tokens: "533k/8k" }),
  row("67", { state: "blocked", glyph: "~", tone: "blu", group: "blocked", time: "-", diff: "-", note: "waits for #103 to close", prio: 4 }),
]);

/** A live run two hours old, its settings, models and one plan reading: every lane has something to show. */
const SNAPSHOT: Snapshot = {
  now: NOW,
  root: "/home/user/project",
  dir: "/home/user/project/.sandcastle",
  name: "project",
  base: "main",
  hasRecord: true,
  record: {
    startedAt: "2026-10-12T11:00:00Z",
    stage: "running",
    tokens: "3.0M in / 35k out",
    usage: [{ provider: "claude", at: NOW - 60, windows: { fiveHour: { percent: 2, resetsAt: NOW + 7200 }, week: { percent: 13, resetsAt: Date.UTC(2026, 9, 14, 6, 0, 0) / 1000 } } }],
  },
  tickets: {},
  live: true,
  outcomes: {},
  logs: [],
  tails: {},
  worktrees: [],
  branches: {},
  containers: {},
  cpus: 8,
  pool: { sandboxes: { used: 2, limit: "3" }, gates: { used: 1, limit: "1" } },
  queue: { tickets: [] },
  unpushed: 0,
  settings: { from: "live", settings: { autonomy: "drain", turn: 1, cap: 20, repair: 1, concurrency: 2, asked: 4, crossReview: false, usageGuard: false } },
  models: "implement claude-sonnet-5-5/high · review claude-opus-5-5/high",
  runOutput: [],
  links: false,
  clickMod: "",
};

const draw = (cols: number, rows = 400, { snapshot = SNAPSHOT, table = TABLE, showAll = false } = {}): string[] =>
  renderFrame(snapshot, table, { cols, rows, showAll, colours: palette(false, false) }).replace(/\n$/, "").split("\n");

const WIDTHS = Array.from({ length: 330 - 60 + 1 }, (_, i) => 60 + i);
const LANES = /[┌├┬]─ (RUN|MACHINE|MODELS|SETTINGS|PLAN) ─/g;
const HAS_LANE = /[┌├┬]─ (RUN|MACHINE|MODELS|SETTINGS|PLAN) ─/;

/** The lanes beside the logo (in the top rule), under it (in a rule below the logo's band) and folded into the summary line. */
const lanesOf = (frame: string[]) => {
  const named = (line: string | undefined) => [...(line ?? "").matchAll(LANES)].map((m) => m[1]!);
  const beside = named(frame[0]);
  const beneath = named(frame.slice(1).find((l) => l.startsWith("├") && HAS_LANE.test(l)));
  const summary = frame.find((l) => /^│ (run|machine|models|settings|plan) {2}/.test(l));
  const folded = summary ? summary.slice(2, -2).split(" │ ").flatMap((part) => part.match(/^(\w+) {2}/)?.[1]?.toUpperCase() ?? []) : [];
  return { beside, beneath, folded, summary };
};

/** The table's headings and each column's width, padding included. */
const columnsOf = (frame: string[]) => {
  const head = frame.find((l) => /^│ +TICKET +│/.test(l));
  assert.ok(head, frame.join("\n"));
  const cells = head.split("│").slice(1, -1);
  return { names: cells.map((c) => c.trim()), widths: cells.map((c) => c.length) };
};

// What the ticket sets, for ticket ids of 4 characters (TICKET at its least, 8): the fixed columns 8, 15, 9, 13, 13
// and 14 wide and eight bars leave ACTIVITY 40 from 120 columns; without CPU/MEM from 106, without DIFF too from
// 92, without TOKENS too from 77; STATE then narrows a cell a column to 11 at 73; below that ACTIVITY takes the rest.
const expectedColumns = (cols: number): [string, number][] => {
  if (cols >= 120) return [["TICKET", 8], ["STATE", 15], ["TIME", 9], ["DIFF", 13], ["CPU/MEM", 13], ["TOKENS", 14], ["ACTIVITY", cols - 80]];
  if (cols >= 106) return [["TICKET", 8], ["STATE", 15], ["TIME", 9], ["DIFF", 13], ["TOKENS", 14], ["ACTIVITY", cols - 66]];
  if (cols >= 92) return [["TICKET", 8], ["STATE", 15], ["TIME", 9], ["TOKENS", 14], ["ACTIVITY", cols - 52]];
  if (cols >= 77) return [["TICKET", 8], ["STATE", 15], ["TIME", 9], ["ACTIVITY", cols - 37]];
  if (cols >= 73) return [["TICKET", 8], ["STATE", cols - 62], ["TIME", 9], ["ACTIVITY", 40]];
  return [["TICKET", 8], ["STATE", 11], ["TIME", 9], ["ACTIVITY", cols - 33]];
};

// The lanes' widths, padding included, from their widest rows: RUN 33 ("● running · 2h00m · since 11:00"), MACHINE
// 19 ("sandboxes ██░ 2/3"), MODELS 24 ("impl   sonnet-5-5/high"), SETTINGS 32 ("○ cross-review · ○ usage-guard"),
// PLAN 43 (its week row, under the provider's name); the logo 51. Beside the logo, with the bars: three lanes from
// 132 columns, four from 165, all five from 209. Under it: RUN from 35, MACHINE from 55, MODELS from 80, SETTINGS
// from 113.
const ORDER = ["RUN", "MACHINE", "MODELS", "SETTINGS", "PLAN"];
const expectedLanes = (cols: number) => {
  const placed = cols >= 209 ? 5 : cols >= 165 ? 4 : cols >= 132 ? 3 : cols >= 113 ? 4 : cols >= 80 ? 3 : 2;
  return { beside: cols >= 132 ? ORDER.slice(0, placed) : [], beneath: cols >= 132 ? [] : ORDER.slice(0, placed), folded: ORDER.slice(placed) };
};

test("no line is wider than the pane, at every width from 60 to 330 columns and at several heights", () => {
  for (const cols of WIDTHS) {
    for (const [rows, showAll] of [[12, false], [24, false], [40, false], [400, false], [24, true]] as const) {
      const frame = draw(cols, rows, { showAll });
      for (const line of frame) assert.ok(visibleWidth(line) <= cols, `${cols}x${rows}: ${visibleWidth(line)} cells: ${line}`);
      // The frame's own lines are the pane's width exactly, so its right edge is one line.
      for (const line of frame) if (/^[┌├└│]/.test(line)) assert.equal(visibleWidth(line), cols, `${cols}x${rows}: ${line}`);
    }
  }
});

test("the logo's three rows show whole at every width in a pane tall enough", () => {
  for (const cols of WIDTHS) {
    const frame = draw(cols).join("\n");
    assert.match(frame, /│ +▄ ▄ ▄ \+ {3}s a n d c a s t l e - k i t {2}· {3}\+ {3}· +│/, `${cols} columns`);
    assert.match(frame, /│ +█████ {5}project +│/, `${cols} columns`);
    assert.match(frame, /│ +██▀██ · {3}base main {2}· {2}13:00:00 +│/, `${cols} columns`);
    assert.doesNotMatch(frame, /sandcastle-kit/, `${cols} columns: the one-row logo`);
  }
});

test("a pane too short in rows folds the logo to one row where that saves rows, and keeps all three beside the lanes", () => {
  for (const cols of WIDTHS) {
    const frame = draw(cols, 12).join("\n");
    if (cols >= 132) {
      // Beside the lanes the header is three rows high either way.
      assert.match(frame, /▄ ▄ ▄ \+ {3}s a n d c a s t l e - k i t/, `${cols} columns`);
      assert.doesNotMatch(frame, /sandcastle-kit/, `${cols} columns`);
    } else {
      // On a band of its own, or beside the lanes where the narrower form lets them fit (from 130 columns).
      assert.match(frame, /│ +sandcastle-kit {2}project {2}base main {2}· {2}13:00:00 +│/, `${cols} columns`);
      assert.doesNotMatch(frame, /▄ ▄ ▄/, `${cols} columns`);
    }
  }
});

test("the lanes sit beside the logo when it and three of them fit, else in a row under it, and the rest fold into the summary line", () => {
  for (const cols of WIDTHS) {
    const { beside, beneath, folded, summary } = lanesOf(draw(cols));
    const want = expectedLanes(cols);
    assert.deepEqual([beside, beneath], [want.beside, want.beneath], `${cols} columns`);
    if (want.folded.length === 0) assert.equal(summary, undefined, `${cols} columns`);
    else {
      // A summary line cut with … may lose the last lanes' names.
      assert.ok(summary, `${cols} columns: no summary line`);
      assert.deepEqual(folded, want.folded.slice(0, folded.length), `${cols} columns`);
      if (folded.length < want.folded.length) assert.match(summary, /… +│$/, `${cols} columns`);
    }
  }
});

test("the summary line names each folded lane and joins its rows with ·, the lanes apart by │", () => {
  const { summary } = lanesOf(draw(140));
  assert.equal(
    summary,
    `│ settings  autonomy [drain] · concurrency 2 (asked 4) · ○ cross-review · ○ usage-guard │ plan  claude 5h ▓░░░░ 2% · resets 15:00 · week … │`,
  );
});

test("each lane's rows: the run's state, start, turn and tokens; the pool; the models without claude-; the settings; the plan", () => {
  const frame = draw(330).join("\n");
  for (const cell of [
    "● running · 2h00m · since 11:00",
    "turn 1/20",
    "tokens 3.0M in / 35k out",
    "sandboxes ██░ 2/3",
    "gates     █ 1/1",
    "waiting   none",
    "impl   sonnet-5-5/high",
    "review opus-5-5/high",
    "repair 1",
    "autonomy [drain]",
    "concurrency 2 (asked 4)",
    "○ cross-review · ○ usage-guard",
    "claude 5h   ▓░░░░   2% · resets 15:00",
    "week ▓░░░░  13% · resets Wed 06:00",
    "(1m ago)",
  ])
    assert.ok(frame.includes(` ${cell} `), `no lane row ${cell}\n${frame}`);
  assert.doesNotMatch(frame, /claude-/);
});

test("the plan lane is left out without a reading", () => {
  const snapshot = { ...SNAPSHOT, record: { ...SNAPSHOT.record, usage: [{ provider: "claude" as const }] } };
  for (const cols of [100, 200, 330]) {
    const { beside, beneath, folded } = lanesOf(draw(cols, 400, { snapshot }));
    assert.ok(![...beside, ...beneath, ...folded].includes("PLAN"), `${cols} columns`);
  }
  assert.deepEqual(lanesOf(draw(330, 400, { snapshot })).beside, ["RUN", "MACHINE", "MODELS", "SETTINGS"]);
});

test("the table's columns keep their set widths and give way in order, ACTIVITY taking the rest, at least 40 from 73 columns", () => {
  for (const cols of WIDTHS) {
    const { names, widths } = columnsOf(draw(cols));
    assert.deepEqual(
      names.map((n, i) => [n, widths[i]]),
      expectedColumns(cols),
      `${cols} columns`,
    );
    if (cols >= 73) assert.ok(widths.at(-1)! >= 40, `${cols} columns: ACTIVITY ${widths.at(-1)}`);
  }
});

test("TICKET fits the longest id shown, between 8 and 16, and cuts a longer one with …", () => {
  const ids = (shown: string[]) => tableOf(shown.map((s, i) => row(String(i), { shown: s })));
  assert.equal(columnsOf(draw(200, 400, { table: ids(["#1", "#22"]) })).widths[0], 8);
  assert.equal(columnsOf(draw(200, 400, { table: ids(["#1", "review-0012"]) })).widths[0], 13);
  const long = draw(200, 400, { table: ids(["#1", "a-ticket-slug-far-too-long"]) });
  assert.equal(columnsOf(long).widths[0], 16);
  assert.ok(long.some((l) => l.startsWith("│ a-ticket-slug… │")), long.join("\n"));
});

test("STATE narrows to its glyph and a short word, cut with …, in a pane under 77 columns", () => {
  const table = tableOf([row("1", { state: "uncommitted", glyph: "!", group: "needs you" })]);
  assert.ok(draw(77, 400, { table }).some((l) => l.includes("│ ! uncommitted │")));
  assert.ok(draw(73, 400, { table }).some((l) => l.includes("│ ! uncomm… │")));
  assert.ok(draw(60, 400, { table }).some((l) => l.includes("│ ! uncomm… │")));
});

test("every column but STATE and ACTIVITY is centred, and a note that does not fit is cut with … on one line", () => {
  const frame = draw(140);
  const r = frame.find((l) => l.includes("#120"))!;
  assert.deepEqual(r.split("│").slice(1, 7), ["  #120  ", " ● impl        ", "   6m    ", "  +96 \u22121159  ", "  1.4c/2.1G  ", "   2.5M/27k   "]);
  assert.match(r, /│ editing docs\/DEPLOYMENT\.md - removing the Pages deploy se… │$/);
  assert.equal(frame.filter((l) => l.includes("API_WORKER")).length, 0);
  // Where it fits, the whole note.
  assert.ok(draw(330).some((l) => / the API_WORKER paragraph +│$/.test(l)));
});

test("the run lane says a pause, a usage pause, a stopped landing and an API key's spend, which the fact reader reads at any width", async () => {
  const { readFacts } = await import("./status-run.ts");
  const at = (record: Snapshot["record"], cols: number, settings = SNAPSHOT.settings) =>
    readFacts(draw(cols, 400, { snapshot: { ...SNAPSHOT, record: { ...SNAPSHOT.record, ...record }, settings } }).join("\n"), SNAPSHOT.root);
  const tickets = { "12": { state: "review" as const } };
  for (const cols of [60, 100, 330]) {
    const paused = at({ paused: { since: NOW - 1200, finishing: ["12"] }, tickets }, cols).run;
    assert.deepEqual([paused.state, paused.finishing, paused.turn], ["PAUSED since 12:40", "#12 review", "1/20"], `${cols} columns`);
    const usage = at({ paused: { since: NOW - 60, finishing: [], cause: "usage", provider: "claude", window: "week", percent: 95, resumesAt: Date.UTC(2026, 9, 14, 6, 1, 0) / 1000 } }, cols).run;
    assert.deepEqual([usage.state, usage.resumes, usage.started], ["PAUSED - weekly usage 95%", "Wed 06:01", "11:00"], `${cols} columns`);
    const stopped = at({ stopped: "main moved" }, cols).run;
    assert.deepEqual([stopped.state, stopped.started], ["STOPPED landing · 2h00m · lands nothing more", "11:00"], `${cols} columns`);
    // An API key the sandboxes spend is red in the first lane, so no pane is too narrow for it.
    const api = at({}, cols, { from: "live", settings: { ...SNAPSHOT.settings!.settings, apiKey: true } }).run;
    assert.equal(api.api, "API credits", `${cols} columns`);
  }
});
