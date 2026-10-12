// The status view's TICKET column fits the longest id the frame shows (#695): the collapsing view draws no row for
// a ticket that waits for a later run, so a long id among those leaves the column as it is. The renderer is pure,
// so no process, no Docker, no network.
//
//   pnpm test:file test/status-ticket-width.test.ts

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row, Table } from "../src/status-rows.ts";
import type { Snapshot } from "../src/status-snapshot.ts";

const { palette, renderFrame } = await import("../src/status-render.ts");

const NOW = Date.UTC(2026, 9, 12, 13, 0, 0) / 1000;

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

const SLUG = "later-slug";
const TABLE: Table = {
  rows: [row("12"), row("13"), row(SLUG, { shown: SLUG, state: "later", glyph: "…", tone: "gry", group: "later", prio: 6 })],
  counts: { working: 2, "needs you": 0, ready: 0, queued: 0, blocked: 0, merged: 0, later: 1, "left over": 0, idle: 0 },
  partly: 0,
  later: { ids: [SLUG], blocked: 0 },
};

const SNAPSHOT: Snapshot = {
  now: NOW,
  root: "/home/user/project",
  dir: "/home/user/project/.sandcastle",
  name: "project",
  base: "main",
  hasRecord: true,
  record: { startedAt: "2026-10-12T11:00:00Z", stage: "running" },
  tickets: {},
  live: true,
  outcomes: {},
  logs: [],
  tails: {},
  worktrees: [],
  branches: {},
  containers: {},
  cpus: 8,
  pool: { sandboxes: { used: 2, limit: "3" }, gates: { used: 0, limit: "1" } },
  queue: { tickets: [] },
  unpushed: 0,
  models: "",
  runOutput: [],
  links: false,
  clickMod: "",
};

const ticketWidth = (showAll: boolean) => {
  const frame = renderFrame(SNAPSHOT, TABLE, { cols: 200, rows: 400, showAll, colours: palette(false, false) }).split("\n");
  const head = frame.find((l) => /^│ +TICKET +│/.test(l));
  assert.ok(head, frame.join("\n"));
  return { width: head.split("│")[1]!.length, frame: frame.join("\n") };
};

test("a later run's ticket the collapsing view does not draw leaves TICKET at the width of the ids it shows", () => {
  const collapsed = ticketWidth(false);
  assert.doesNotMatch(collapsed.frame, new RegExp(`│ +${SLUG} +│`), "the later ticket has no row");
  assert.match(collapsed.frame, /1 for a later run \(later-slug\)/);
  assert.equal(collapsed.width, 8);
});

test("every row drawn, a later run's ticket among them, TICKET fits its id", () => {
  const all = ticketWidth(true);
  assert.match(all.frame, new RegExp(`│ +${SLUG} +│`));
  assert.equal(all.width, SLUG.length + 2);
});
