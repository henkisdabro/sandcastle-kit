// A run that opens no Herdr view (outside Herdr, or with SANDCASTLE_HERDR_VIEW=0) marks an earlier
// run's view record `reported` at start, keeping its tab and pane ids. Otherwise the record stays
// an own, unreported tab: the tab bar's tick types the status view into its pane (ids a Herdr
// restart may have given to someone's shell) and the run's live-runs file is kept at exit.
// A fake `herdr` logs every call; the exit is a real child process. No Herdr, no network.
//
//   pnpm test:file test/herdr-no-view.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Project } from "../src/config.ts";
import { KIT, runKit } from "./cli-spawn.ts";
import { everyPidIsTheKit } from "./kit-process.ts";

const FAKE = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "pane get") printf '{"result":{"pane":{"pane_id":"%s","tab_id":"w1:t2"}}}\\n' "$3" ;;
  "pane process-info") printf '{"result":{"process_info":{"foreground_processes":[{"cmdline":"-zsh"}]}}}\\n' ;;
  *) echo '{}' ;;
esac
`;
const bin = mkdtempSync(join(tmpdir(), "sandcastle-noview-bin-"));
writeFileSync(join(bin, "herdr"), FAKE);
chmodSync(join(bin, "herdr"), 0o755);
const log = join(mkdtempSync(join(tmpdir(), "sandcastle-noview-log-")), "calls.log");
Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_LOG: log, XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-noview-cache-")) });
// Outside Herdr, as a run from a plain terminal: IN_HERDR is read when herdr.ts loads.
for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "SANDCASTLE_HERDR_VIEW"]) delete process.env[k];
const { openSandboxView, restartStatusView, tellDeadTab, viewRecord } = await import("../src/herdr.ts");
const { replaceDeadTab, runsLine } = await import("../src/herdr-plugin.ts");

const OWN = { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: ["w1:t2-2"] };
const calls = () => (readFileSync(log, "utf8") ? readFileSync(log, "utf8").trim().split("\n") : []);
const typed = () => calls().filter((c) => c.startsWith("pane run "));
const fresh = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `sandcastle-noview-${name}-`)));
const project = (view?: object) => {
  const root = fresh("project");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  if (view) writeFileSync(viewRecord(root), JSON.stringify(view) + "\n");
  writeFileSync(log, "");
  return root;
};
const record = (root: string) => JSON.parse(readFileSync(viewRecord(root), "utf8"));

test("a run outside Herdr marks the earlier record reported and keeps its ids", () => {
  const root = project(OWN);
  const view = openSandboxView({ root, name: "shop" } as Project, 1, (id) => `#${id}`, () => ({}), "none");
  assert.equal(view.status, undefined);
  assert.deepEqual(record(root), { tab: "w1:t2", adopted: false, status: "w1:t2-1", panes: ["w1:t2-2"], reported: true });
  assert.deepEqual(calls(), [], "no herdr call");
});

test("a run with no record, or an already reported one, writes nothing", () => {
  const none = project();
  openSandboxView({ root: none, name: "shop" } as Project, 1, (id) => id);
  assert.equal(existsSync(viewRecord(none)), false);
  const done = project({ ...OWN, reported: true });
  const before = readFileSync(viewRecord(done), "utf8");
  openSandboxView({ root: done, name: "shop" } as Project, 1, (id) => id);
  assert.equal(readFileSync(viewRecord(done), "utf8"), before);
});

test("a tick of the later run types nothing into the earlier run's pane", () => {
  const root = project(OWN);
  const dir = fresh("runs");
  writeFileSync(join(dir, "run"), root);
  writeFileSync(join(root, ".sandcastle/logs/run.json"), JSON.stringify({ orchestrator: "shop", startedAt: "2026-10-04T01:00:00Z", pid: process.pid }));
  const tick = () =>
    runsLine(dir, undefined, (pid) => (pid === process.pid ? everyPidIsTheKit() : undefined), (r) => replaceDeadTab(r, KIT), (r) => void restartStatusView(r, KIT));
  // Without the mark, a bare shell in the recorded pane gets the view typed in.
  writeFileSync(log, "");
  tick();
  assert.equal(typed().length, 1, "the unmarked record is acted on");
  openSandboxView({ root, name: "shop" } as Project, 1, (id) => id);
  writeFileSync(log, "");
  for (const _ of [1, 2]) tick();
  assert.deepEqual(typed(), []);
  assert.equal(tellDeadTab(root, KIT), "left");
  assert.deepEqual(typed(), []);
});

// ---------------------------------------------------------------------------
// Inside Herdr with the view off: the exit is a process of its own.
// ---------------------------------------------------------------------------

const href = (f: string) => JSON.stringify(pathToFileURL(join(KIT, f)).href);
const fixture = join(fresh("fixture"), "run.mts");
writeFileSync(
  fixture,
  `import { registerRun } from ${href("src/live-runs.ts")};
import { openSandboxView } from ${href("src/herdr.ts")};
import { recordRun } from ${href("src/run.ts")};
const root = process.env.FIXTURE_ROOT as string;
recordRun({ root, name: "shop" } as any, { dryRun: true });
registerRun(root);
openSandboxView({ root, name: "shop" } as any, 1, (id) => id);
`,
);

test("a run with the view off leaves the earlier record reported and its live-runs file goes at exit", () => {
  const root = project(OWN);
  const cache = fresh("cache");
  // The plugin's link marker: only then would the earlier record have kept the file.
  mkdirSync(join(cache, "sandcastle-kit"), { recursive: true });
  writeFileSync(join(cache, "sandcastle-kit/herdr-plugin-linked"), "/the/kit");
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cache, FIXTURE_ROOT: root, HERDR_ENV: "1", SANDCASTLE_HERDR_VIEW: "0" };
  for (const k of ["SANDCASTLE_DETACHED", "CLAUDE_CODE_SESSION_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"]) delete env[k];
  const res = runKit([], { script: fixture, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(record(root).reported, true);
  assert.equal(record(root).tab, "w1:t2");
  assert.deepEqual(readdirSync(join(cache, "sandcastle-kit/runs")), []);
  assert.deepEqual(calls(), []);
});
