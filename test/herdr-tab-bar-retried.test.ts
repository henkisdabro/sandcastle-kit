// The Herdr TUI tab bar (`runsLine`, src/herdr-plugin.ts) reads `retriedNextTurn` as the status view does:
// a `not landed` ticket a later autonomy turn takes by itself is no "needs you" yet, and is again in the last turn.
//
//   pnpm test:file test/herdr-tab-bar-retried.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-tab-retried-cache-"));
const { runsLine } = await import("../src/herdr-plugin.ts");

const lineOf = (settings: object) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-tab-retried-runs-"));
  // Real path: git reports one (macOS's temp directory is behind a /var symlink).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-tab-retried-project-")));
  spawnSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/config.ts"), "export default {}\n");
  writeFileSync(join(dir, "shop"), root);
  const record = { orchestrator: "shop", pid: process.pid, startedAt: "2026-10-02T01:00:00Z", settings, tickets: { 1: { state: "merged" }, 2: { state: "not landed" } } };
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify(record));
  return runsLine(dir, undefined, (pid) => (pid === process.pid ? everyPidIsTheKit() : undefined));
};

test("the tab bar: a not landed ticket a later turn retries needs nobody yet; in the last turn it needs you", () => {
  assert.equal(lineOf({ autonomy: "drain", turn: 2, cap: 20 }), "♜ shop 1/2");
  assert.equal(lineOf({ autonomy: "drain", turn: 20, cap: 20 }), "♜ shop 1/2 · 1 needs you");
});
