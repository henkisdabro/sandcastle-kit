// The run settings (src/run-settings.ts): one pure resolver, the settings group each turn's run
// record carries, and the `sandcastle status` input for the next run. No Docker, no model calls.
//
//   pnpm exec tsx --test test/run-settings.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunRecord } from "../mod/hooks/run-record.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");
const { DRAIN_CAP, turnCap } = await import("../src/autonomy.ts");
const { recordRun } = await import("../src/run.ts");
const { OperatorError } = await import("../src/errors.ts");
type Project = Parameters<typeof recordRun>[0];

const OFF = { on: false } as const;
const resolve = (env: Record<string, string | undefined>, autonomy?: unknown) => resolveSettings({ env, project: { autonomy }, machine: {} }).autonomy;

test("the environment beats the project config, which beats the default", () => {
  const table: [string, Record<string, string | undefined>, unknown, unknown][] = [
    ["nothing set", {}, undefined, 0],
    ["config only", {}, 2, 2],
    ["environment only", { AUTONOMY_LEVEL: "3" }, undefined, 3],
    ["environment over config", { AUTONOMY_LEVEL: "1" }, 3, 1],
    ["environment 0 over config drain", { AUTONOMY_LEVEL: "0" }, "drain", 0],
    ["an empty variable is unset", { AUTONOMY_LEVEL: "" }, 2, 2],
    ["drain from the environment", { AUTONOMY_LEVEL: "drain" }, 1, "drain"],
    ["drain from config", {}, "drain", "drain"],
  ];
  for (const [name, env, config, want] of table) assert.equal(resolve(env, config), want, name);
});

test("every level resolves, with its cap: 0 is one turn, 1 has none, 2 and 3 their own number, drain 20", () => {
  const table: [string, unknown, number | undefined][] = [
    ["0", 0, 1],
    ["1", 1, undefined],
    ["2", 2, 2],
    ["3", 3, 3],
    ["drain", "drain", DRAIN_CAP],
  ];
  for (const [env, level, cap] of table) {
    assert.equal(resolve({ AUTONOMY_LEVEL: env }), level, `level ${env}`);
    assert.equal(turnCap(level as 0), cap, `cap of ${env}`);
  }
  assert.equal(DRAIN_CAP, 20);
});

test("a bad level is an OperatorError, from either source", () => {
  assert.throws(() => resolve({ AUTONOMY_LEVEL: "4" }), OperatorError);
  assert.throws(() => resolve({}, 9), OperatorError);
});

test("the resolver reads nothing but its arguments", () => {
  process.env.AUTONOMY_LEVEL = "3";
  try {
    assert.equal(resolve({}), 0);
  } finally {
    delete process.env.AUTONOMY_LEVEL;
  }
});

test("the settings group carries the level, the turn and the cap; level 1 has no cap", () => {
  const rest = { crossReview: OFF, repair: 1, concurrency: { asked: 4, effective: 4 } };
  const also = { crossReview: false, repair: 1, concurrency: 4, asked: 4 };
  assert.deepEqual(settingsGroup({ ...rest, autonomy: 0 }, 1), { autonomy: 0, turn: 1, cap: 1, ...also });
  assert.deepEqual(settingsGroup({ ...rest, autonomy: 3 }, 2), { autonomy: 3, turn: 2, cap: 3, ...also });
  assert.deepEqual(settingsGroup({ ...rest, autonomy: "drain" }, 7), { autonomy: "drain", turn: 7, cap: 20, ...also });
  assert.deepEqual(settingsGroup({ ...rest, autonomy: 1 }, 2), { autonomy: 1, turn: 2, ...also });
});

test("a written record carries its settings, and a later turn's record its own turn number", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-run-settings-"));
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  const project = { root, name: "fixture" } as unknown as Project;
  const file = join(root, ".sandcastle/logs/run.json");
  const read = () => JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  const settings = resolveSettings({ env: { AUTONOMY_LEVEL: "3" }, project: {}, machine: {} });
  recordRun(project, { settings: settingsGroup(settings, 1) });
  assert.deepEqual(read().settings, { autonomy: 3, turn: 1, cap: 3, repair: 1, concurrency: 4, asked: 4, crossReview: false });
  // The next turn writes a fresh record: the level is the run's, the turn its own.
  recordRun(project, { settings: settingsGroup(settings, 2) });
  assert.deepEqual(read().settings, { autonomy: 3, turn: 2, cap: 3, repair: 1, concurrency: 4, asked: 4, crossReview: false });
});
