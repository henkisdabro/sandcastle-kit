// The SETTINGS lane marks a value that came from `.sandcastle/config.local.json`: the settings group
// records the dotted keys the file set whose value the environment did not override, and the lane
// draws `local` after autonomy, concurrency and usage-pause. No Docker, no model calls.
//
//   pnpm test:file test/status-settings-local.test.ts

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Row, Table } from "../src/status-rows.ts";
import type { Snapshot } from "../src/status-snapshot.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");
const { palette, renderFrame } = await import("../src/status-render.ts");

const OFF = { on: false } as const;
const resolved = (env: Record<string, string | undefined>, localKeys?: string[]) =>
  resolveSettings({ env, project: { autonomy: 2, concurrency: 2, usagePause: 80, localKeys }, machine: {} });

test("a settings group records the keys the local file set, and none when it set none", () => {
  const withKeys = settingsGroup({ ...resolved({}), crossReview: OFF, local: ["autonomy"] }, 1);
  assert.deepEqual(withKeys.local, ["autonomy"]);
  const without = settingsGroup({ ...resolved({}), crossReview: OFF }, 1);
  assert.equal("local" in without, false);
  assert.equal("local" in settingsGroup({ ...resolved({}, []), crossReview: OFF }, 1), false);
});

test("a key the environment set instead is not recorded as local", () => {
  const keys = ["autonomy", "concurrency", "usagePause", "implement.model", "review.effort"];
  assert.deepEqual(resolved({}, keys).local, keys);
  assert.deepEqual(resolved({ AUTONOMY_LEVEL: "3" }, ["autonomy", "concurrency"]).local, ["concurrency"]);
  // `--concurrency` sets CONCURRENCY.
  assert.deepEqual(resolved({ CONCURRENCY: "4" }, ["autonomy", "concurrency"]).local, ["autonomy"]);
  assert.deepEqual(resolved({ USAGE_PAUSE: "90" }, keys).local, ["autonomy", "concurrency", "implement.model", "review.effort"]);
  assert.deepEqual(resolved({ IMPL_MODEL: "m", REVIEW_EFFORT: "low" }, keys).local, ["autonomy", "concurrency", "usagePause"]);
  assert.equal(resolved({ AUTONOMY_LEVEL: "3", CONCURRENCY: "4" }, ["autonomy", "concurrency"]).local, undefined);
});

const row = (id: string): Row => ({
  id, shown: `#${id}`, state: "impl", glyph: "●", tone: "ylw", group: "working", time: "6m", timeTone: "head",
  diff: "+1 −1", note: "working", noteTone: "head", prio: 0, key: 0, apart: false,
});
const TABLE: Table = {
  rows: [row("1")],
  counts: { working: 1, "needs you": 0, ready: 0, queued: 0, blocked: 0, merged: 0, later: 0, "left over": 0, idle: 0 },
  partly: 0,
  later: { ids: [], blocked: 0 },
};
const NOW = Date.UTC(2026, 9, 12, 13, 0, 0) / 1000;
const snapshot = (group: Record<string, unknown>): Snapshot => ({
  now: NOW, root: "/home/user/project", dir: "/home/user/project/.sandcastle", name: "project", base: "main", hasRecord: true,
  record: { startedAt: "2026-10-12T11:00:00Z", stage: "running" },
  tickets: {}, live: true, outcomes: {}, logs: [], tails: {}, worktrees: [], branches: {}, containers: {}, cpus: 8,
  pool: { sandboxes: { used: 1, limit: "3" }, gates: { used: 0, limit: "1" } },
  queue: { tickets: [] }, unpushed: 0,
  settings: { from: "live", settings: group },
  models: "implement claude-sonnet-5-5/high · review claude-opus-5-5/high",
  runOutput: [], links: false, clickMod: "",
} as Snapshot);
const draw = (group: Record<string, unknown>) =>
  renderFrame(snapshot(group), TABLE, { cols: 330, rows: 400, showAll: false, colours: palette(false, false) });

const BASE = { autonomy: 2, turn: 1, cap: 2, repair: 1, concurrency: 2, asked: 2, crossReview: false, usageGuard: false, usagePause: 80 };

test("the lane draws local after each local value and nowhere else", () => {
  const frame = draw({ ...BASE, local: ["autonomy", "concurrency", "implement.model"] });
  assert.ok(frame.includes("autonomy [2] local "), frame);
  assert.ok(frame.includes("concurrency 2 local "), frame);
  assert.ok(frame.includes("usage-pause 80% "), frame);
  assert.equal(frame.match(/local/g)?.length, 2, frame);
  assert.ok(draw({ ...BASE, local: ["usagePause"] }).includes("usage-pause 80% local"));
});

test("a clamped concurrency draws the mark after the asked value", () => {
  assert.ok(draw({ ...BASE, concurrency: 3, asked: 8, local: ["concurrency"] }).includes("concurrency 3 (asked 8) local "));
});

test("a record with no local, or one that is not a list of strings, draws the lane as before", () => {
  const plain = draw(BASE);
  assert.doesNotMatch(plain, /local/);
  for (const bad of ["autonomy", 3, { autonomy: true }, ["autonomy", 1], null]) assert.equal(draw({ ...BASE, local: bad }), plain);
});
