// A run a person ended (`sandcastle stop`, Ctrl-C) is recorded as stopped by them, not as a crash:
// its summary heading, its notify line and its "Runnable now" section say so. No Docker, network
// or model call.
//
//   pnpm exec tsx --test test/stopped-by.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { endSummary } from "../src/notify.ts";
import { type Facts, render } from "../src/report.ts";
import { startNode } from "./cli-spawn.ts";

const facts = (over: Partial<Facts>): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T06:45:00.000Z",
  live: false,
  dryRun: true,
  gateCount: 2,
  tickets: { "78": { state: "implement", title: "wordWrap", started: 1 } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  stage: "running",
  exitCode: 1,
  ...over,
});

const section = (text: string, heading: string) => text.split(heading)[1]?.split("\n## ")[0] ?? "";

test("a run stopped by `sandcastle stop` says stopped, not ended early", () => {
  const out = render(facts({ stoppedBy: "sandcastle stop" }), true);
  assert.match(out, /^## Run stopped by `sandcastle stop` - partial summary \(dry run\)/);
  assert.doesNotMatch(out, /ended early|exit 1/);
  assert.match(section(out, "## Next step"), /`sandcastle run` again: it picks up #78/);
});

test("Runnable now has no 'none' line above the cut-short ticket", () => {
  const left = section(render(facts({ stoppedBy: "sandcastle stop" }), true), "## Runnable now / Still blocked");
  assert.match(left, /Cut short when the run ended: #78 \(implement\) - still queued/);
  assert.doesNotMatch(left, /Runnable now: none/);
});

test("Runnable now still says none when nothing is runnable and nothing was cut short", () => {
  const out = render(facts({ stage: "report", exitCode: 0, tickets: { "78": { state: "merged", title: "wordWrap", started: 1 } }, blocked: [{ id: "79", on: ["#78"] }] }), true);
  assert.match(section(out, "## Runnable now / Still blocked"), /Runnable now: none/);
});

test("Ctrl-C and a signal are named as they are", () => {
  assert.match(render(facts({ stoppedBy: "Ctrl-C" }), true), /^## Run stopped by Ctrl-C - partial summary/);
  assert.match(render(facts({ stoppedBy: "SIGTERM" }), true), /^## Run stopped by SIGTERM - partial summary/);
});

test("a run with no stoppedBy still reads as ended early", () => {
  assert.match(render(facts({}), true), /^## Run ended early \(exit 1\)/);
});

test("the notify line says stopped by `sandcastle stop`", () => {
  const tickets = { "78": { state: "implement" as const, title: "wordWrap" } };
  assert.equal(
    endSummary({ exitCode: 1, dryRun: true, stoppedBy: "sandcastle stop", tickets }),
    "run stopped by `sandcastle stop` (dry run) - 0 merged, 0 need you, 0 need fixing, of 1",
  );
  assert.match(endSummary({ exitCode: 1, tickets }), /^run ended with exit 1/);
});

test("a detached run that gets a SIGINT records stoppedBy: sandcastle stop; one in a terminal, Ctrl-C; a hangup, SIGHUP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-stopped-by-"));
  const href = (f: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", f)).href);
  const fixture = join(dir, "fixture.mts");
  writeFileSync(
    fixture,
    `import { exitOnSignal, recordRun } from ${href("src/run.ts")};
recordRun({ root: process.env.FIXTURE_ROOT, name: "fixture" } as any, {});
exitOnSignal();
console.log("ready");
setInterval(() => {}, 1000);
`,
  );
  const stopped = async (detached: boolean, signal: NodeJS.Signals = "SIGINT") => {
    const root = join(dir, `${detached ? "detached" : "terminal"}-${signal}`);
    mkdirSync(root, { recursive: true });
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"), FIXTURE_ROOT: root, SANDCASTLE_DETACHED: detached ? "1" : "" };
    await new Promise<void>((resolve, reject) => {
      const child = startNode([fixture], { env, stdio: ["ignore", "pipe", "inherit"] });
      let sent = false;
      child.stdout!.on("data", (d) => {
        if (!sent && String(d).includes("ready")) {
          sent = true;
          child.kill(signal);
        }
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`fixture still running 15 s after ${signal}`));
      }, 15_000);
      child.on("error", reject);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8"));
  };
  const detached = await stopped(true);
  assert.equal(detached.stoppedBy, "sandcastle stop");
  assert.equal(detached.exitCode, 130);
  assert.equal((await stopped(false)).stoppedBy, "Ctrl-C");
  assert.equal((await stopped(false, "SIGHUP")).stoppedBy, "SIGHUP");
});
