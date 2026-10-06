// The Herdr tab bar line shows each live run's share of the machine's sandbox slots, as its run
// record carries it (`share`, rewritten by the run); a record from an older kit has none, and the
// line is as it was. No Herdr, no network.
//
//   node --test test/herdr-run-share.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { everyPidIsTheKit } from "./kit-process.ts";
import { lineText } from "../src/herdr.ts";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-run-share-cache-"));
const { runsLine } = await import("../src/herdr-plugin.ts");

const project = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-run-share-project-")));
  spawnSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  return root;
};
const register = (dir: string, root: string, record: object) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, Math.random().toString(16).slice(2)), root);
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify(record));
};

test("each live run's share ends its part of the line; a run with none shows none", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-run-share-runs-"));
  const [a, b, c] = [project(), project(), project()];
  register(dir, a, { orchestrator: "shop", pid: process.pid, startedAt: "2026-10-02T01:00:00Z", demand: 5, share: 3, tickets: { 1: { state: "merged" }, 2: { state: "implement" } } });
  register(dir, b, { orchestrator: "api", pid: process.pid, startedAt: "2026-10-02T02:00:00Z", demand: 5, share: 1, cap: 1, tickets: { 1: { state: "review" } } });
  register(dir, c, { orchestrator: "old", pid: process.pid, startedAt: "2026-10-02T00:00:00Z", tickets: { 1: { state: "review" } } });
  assert.equal(
    runsLine(dir, undefined, everyPidIsTheKit),
    "♜ api 0/1 · 1 working · share 1  |  shop 1/2 · 1 working · share 3  |  old 0/1 · 1 working",
  );
});

test("a share of 0 (a drained run) is still shown", () => {
  assert.equal(lineText("shop", { working: 0, needsYou: 0, merged: 2, total: 2 }, 0), "shop 2/2 · share 0");
  assert.equal(lineText("shop", { working: 1, needsYou: 1, merged: 0, total: 2 }, 4), "shop 0/2 · 1 working · 1 needs you · share 4");
});
