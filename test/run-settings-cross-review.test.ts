// Cross-review as a run setting: the resolver (off by default, on with the default or a set model
// and effort), the settings group a record carries, and the status view's `● cross-review <model>
// <effort>` / `○ cross-review` item, with the models cell holding only models for a record that
// carries it. A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm test:file test/run-settings-cross-review.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");
const { OperatorError } = await import("../src/errors.ts");

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-cross-review-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const REPO = join(TMP, "repo");
const FAKE = join(TMP, "bin");
const LOGS = join(REPO, ".sandcastle", "logs");
mkdirSync(LOGS, { recursive: true });
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
script(join(FAKE, "sandcastle"), "#!/usr/bin/env bash\nprintf '[]\\n'\n");
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
execFileSync("git", ["-C", REPO, "init", "-q", "-b", "main"]);
execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);

const now = new Date().toISOString();
/** A finished run's record, so the view draws no live run, with the given extra fields. */
const record = (extra: Record<string, unknown>) =>
  writeFileSync(join(LOGS, "run.json"), JSON.stringify({ orchestrator: "fixture", pid: 1, startedAt: now, finishedAt: now, exitCode: 0, models: "m", issues: [], ...extra }));

/** The view's lines at `cols` columns, colour stripped, with SANDCASTLE_SETTINGS only when `next` is given. */
const frame = (cols: number, next?: string): string[] => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: [FAKE, process.env.PATH].join(":"),
    SANDCASTLE_PROJECT: REPO,
    SANDCASTLE_BIN: join(FAKE, "sandcastle"),
    SANDCASTLE_BASE: "main",
    SANDCASTLE_NAME: "fixture",
    TERM_COLS: String(cols),
    TERM_ROWS: "200",
    XDG_CACHE_HOME: join(TMP, "cache"),
  };
  delete env.SANDCASTLE_SETTINGS;
  if (next !== undefined) env.SANDCASTLE_SETTINGS = next;
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const lines = r.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  for (const l of lines) assert.ok([...l].length <= cols, `wider than ${cols} columns: ${l}`);
  return lines;
};
/** The settings row's text between the bars, trimmed, or undefined when the view draws none. */
const row = (lines: string[]) => lines.find((l) => l.startsWith("│ settings "))?.replace(/^│ /, "").replace(/ *│$/, "");


const resolve = (env: Record<string, string | undefined>) => resolveSettings({ env, project: {}, machine: {} }).crossReview;

test("cross-review is off by default, and the companions do not turn it on", () => {
  assert.deepEqual(resolve({}), { on: false });
  assert.deepEqual(resolve({ CROSS_REVIEW: "0" }), { on: false });
  assert.deepEqual(resolve({ CROSS_REVIEW_MODEL: "some-model", CROSS_REVIEW_EFFORT: "low" }), { on: false });
});

test("on with the default model and effort, and with set ones", () => {
  assert.deepEqual(resolve({ CROSS_REVIEW: "1" }), { on: true, model: "gpt-6-astra", effort: "high" });
  assert.deepEqual(resolve({ CROSS_REVIEW: "1", CROSS_REVIEW_MODEL: "other-model", CROSS_REVIEW_EFFORT: "xhigh" }), { on: true, model: "other-model", effort: "xhigh" });
});

test("Codex has no max effort: a bad one is an OperatorError", () => {
  assert.throws(() => resolve({ CROSS_REVIEW: "1", CROSS_REVIEW_EFFORT: "max" }), OperatorError);
});

test("the settings group carries cross-review, and its model and effort only when it is on", () => {
  const on = resolveSettings({ env: { CROSS_REVIEW: "1" }, project: {}, machine: {} });
  assert.deepEqual(settingsGroup(on, 1), { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4, crossReview: true, crossReviewModel: "gpt-6-astra", crossReviewEffort: "high", usageGuard: false });
  const off = resolveSettings({ env: {}, project: {}, machine: {} });
  assert.deepEqual(settingsGroup(off, 1), { autonomy: 0, turn: 1, cap: 1, repair: 1, concurrency: 4, asked: 4, crossReview: false, usageGuard: false });
});

const MODELS = "implement claude-sonnet-5-5/high · review claude-opus-5-5/high";
const WITH = `${MODELS} · cross-review gpt-6-astra/high`;
/** The view's lines whose text holds `word`, trimmed of the frame. */
const lines = (all: string[], word: string) => all.filter((l) => l.includes(word));

test("on: the row shows model and effort, and the models cell holds only models", () => {
  record({ models: WITH, settings: { autonomy: 0, turn: 1, cap: 1, crossReview: true, crossReviewModel: "gpt-6-astra", crossReviewEffort: "high" } });
  assert.equal(row(frame(80)), "settings  autonomy 0 · turn 1/1 · ● cross-review gpt-6-astra high (last run)");
  assert.equal(row(frame(100)), "settings  autonomy [0] 1 2 3 drain · turn 1/1 · ● cross-review gpt-6-astra high (last run)");
  for (const cols of [80, 100, 200]) assert.equal(lines(frame(cols), "cross-review").length, 1, `${cols} columns: shown once`);
  // Wide, the models cell is its own column and shows every model: here, only the two.
  const wide = frame(200);
  assert.ok(wide.some((l) => l.includes("review    claude-opus-5-5/high")), "the models stay");
  assert.ok(!wide.some((l) => /cross-review ?gpt-6-astra\/high/.test(l)), "the models cell has no cross-review");
});

test("off: the row shows ○ cross-review from 80 columns and drops it below", () => {
  record({ models: MODELS, settings: { autonomy: 0, turn: 1, cap: 1, crossReview: false } });
  assert.equal(row(frame(100)), "settings  autonomy [0] 1 2 3 drain · turn 1/1 · ○ cross-review (last run)");
  assert.equal(row(frame(80)), "settings  autonomy 0 · turn 1/1 · ○ cross-review (last run)");
  assert.equal(row(frame(79)), "settings  autonomy 0 · turn 1/1 (last run)");
});

test("an old record keeps its models string as written, and draws no cross-review item", () => {
  record({ models: WITH, settings: { autonomy: 0, turn: 1, cap: 1 } });
  const has = (all: string[]) => all.some((l) => /cross-review ?gpt-6-astra\/high/.test(l));
  assert.equal(row(frame(100)), "settings  autonomy [0] 1 2 3 drain · turn 1/1 (last run)");
  assert.ok(has(frame(200)), "the models cell still holds it");
  record({ models: WITH });
  assert.ok(has(frame(200)));
});

test("idle: the next run's setting, passed by `sandcastle status`, gives the row item", () => {
  record({ models: MODELS, settings: { autonomy: 0, turn: 1, cap: 1, crossReview: false } });
  const next = JSON.stringify({ autonomy: 0, turn: 1, cap: 1, crossReview: true, crossReviewModel: "other-model", crossReviewEffort: "xhigh" });
  assert.match(row(frame(100, next)) ?? "", /^settings {2}next run: .*· ● cross-review other-model xhigh$/);
});

test("a model or effort that is not plain text is never drawn", () => {
  record({ models: MODELS, settings: { autonomy: 0, turn: 1, cap: 1, crossReview: true, crossReviewModel: "\u001b]0;x\u0007 evil", crossReviewEffort: "rm -rf" } });
  assert.match(row(frame(100)) ?? "", /· ● cross-review \(last run\)$/);
});
