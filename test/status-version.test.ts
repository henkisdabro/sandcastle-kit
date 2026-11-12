// The kit's version in the status view's logo (#919): after the clock, divided from it as the clock is from the
// base, on the third row of the three-row logo and at the end of the one-row logo; none when the snapshot has none
// (the logo is then as before). `status 0` in a project draws the installed kit's own package.json version.
// The renderer is pure, so the first tests run no process; the last starts the view on a made-up project.
//
//   pnpm test:file test/status-version.test.ts

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Snapshot } from "../src/status-snapshot.ts";
import { buildFixture } from "./status-fixture.ts";
import { drawFrame } from "./status-run.ts";

const { palette, renderFrame } = await import("../src/status-render.ts");
const { ticketRows } = await import("../src/status-rows.ts");

const NOW = Date.UTC(2026, 9, 12, 13, 0, 0) / 1000;

const snapshot = (version?: string): Snapshot => ({
  now: NOW,
  root: "/home/user/project",
  dir: "/home/user/project/.sandcastle",
  name: "project",
  base: "main",
  hasRecord: false,
  record: {},
  tickets: {},
  live: false,
  outcomes: {},
  logs: [],
  tails: {},
  worktrees: [],
  branches: {},
  containers: {},
  cpus: 8,
  pool: { sandboxes: { used: 0, limit: "3" }, gates: { used: 0, limit: "1" } },
  queue: { tickets: [] },
  unpushed: 0,
  models: "",
  runOutput: [],
  links: false,
  clickMod: "",
  ...(version ? { version } : {}),
});

const draw = (s: Snapshot, cols: number, rows: number, colours = palette(false, false)): string[] =>
  renderFrame(s, ticketRows(s), { cols, rows, showAll: false, colours }).replace(/\n$/, "").split("\n");

test("the version follows the clock on the third row of the three-row logo", () => {
  const frame = draw(snapshot("0.24.0"), 200, 400);
  const row = frame.find((l) => l.includes("██▀██"));
  assert.ok(row, frame.join("\n"));
  assert.match(row, /base main {2}· {2}13:00:00 {2}· {2}v0\.24\.0/);
  assert.equal(frame.filter((l) => l.includes("v0.24.0")).length, 1);
});

test("the version ends the one-row logo of a short pane", () => {
  const frame = draw(snapshot("0.24.0"), 90, 10);
  const row = frame.find((l) => l.includes("sandcastle-kit"));
  assert.ok(row, frame.join("\n"));
  assert.match(row, /sandcastle-kit {2}project {2}base main {2}· {2}13:00:00 {2}· {2}v0\.24\.0/);
});

test("no version draws the logo as it always was", () => {
  for (const [cols, rows] of [[200, 400], [60, 10]] as const) {
    const frame = draw(snapshot(), cols, rows).join("\n");
    assert.doesNotMatch(frame, /v\d/);
    assert.match(frame, /13:00:00 +│/);
  }
});

test("the version is in the muted colour and the clock keeps the accent", () => {
  const colours = palette(true, true);
  const frame = draw(snapshot("0.24.0"), 200, 400, colours).join("\n");
  assert.ok(frame.includes(`${colours.accent}13:00:00${colours.off}`));
  assert.ok(frame.includes(`${colours.mute}v0.24.0${colours.off}`));
});

test("status 0 in a project prints the installed kit's version", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const fixture = buildFixture("ended", mkdtempSync(join(tmpdir(), "sandcastle-status-version-")));
  try {
    const { frame, status, stderr } = drawFrame(fixture, { cols: 200 });
    assert.equal(status, 0, stderr);
    assert.match(frame, new RegExp(`13:00:00 {2}· {2}v${version.replace(/\./g, "\\.")}`));
  } finally {
    fixture.stop();
  }
});
