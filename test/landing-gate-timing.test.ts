// A landing gate is timed and estimated like the other steps: it writes a timings line of its own
// phase, the estimate counts it in the gates pool's sum and takes the landings in a row as a floor
// on the run's end, and the status view's `ends ~HH:MM` follows. Made-up timings and run records;
// no tracker, Docker or network.
//
//   pnpm exec tsx --test test/landing-gate-timing.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { kitLikeProcess } from "./kit-process.ts";

// Importing run.ts must not touch the real slots.
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = join(TMP, "cache");
const live = kitLikeProcess();
after(() => {
  live.kill();
  rmSync(TMP, { recursive: true, force: true });
});
const { estimate, typicalTimes } = await import("../src/run.ts");
const { LANDING_GATES, timedLandingGate } = await import("../src/gates.ts");
type Project = Parameters<typeof estimate>[0];

const MIN = 60_000;
const tokens = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };
const line = (o: object) => JSON.stringify({ project: "fixture", run: "r1", ...o });

const project = (extra: string[] = [], landMs: number | null = 5 * MIN) => {
  const root = mkdtempSync(join(TMP, "estimate-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = ["1", "2", "3"].flatMap((issue) => [
    line({ issue, phase: "implement", ms: 4 * MIN, tokens }),
    line({ issue, phase: "gates", ms: 3 * MIN }),
    line({ issue, phase: "gates", ms: 3 * MIN }),
    ...(landMs === null ? [] : [line({ issue, phase: LANDING_GATES, ms: landMs, waitMs: 30 * MIN })]),
  ]);
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), [...lines, ...extra].join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

test("a landing gate writes a line of its own phase: green, red, and one that throws", async () => {
  const timings = join(TMP, "timings.jsonl");
  const who = { run: "r1", project: "fixture", issue: "7", carried: true };
  await timedLandingGate(timings, who, async () => ({ gates: [{ name: "test", pass: true, ms: 40 }], waitMs: 0 }));
  await timedLandingGate(timings, who, async () => ({ gates: [{ name: "lint", pass: false, ms: 10 }] }));
  await assert.rejects(timedLandingGate(timings, who, async () => { throw new Error("no sandbox"); }), /no sandbox/);
  const lines = readFileSync(timings, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.deepEqual([l.phase, l.issue, l.run, l.project, l.carried], [LANDING_GATES, "7", "r1", "fixture", true]);
  assert.deepEqual(lines.map((l) => l.ok), [true, false, false]);
  assert.deepEqual(lines[0].gates, { test: 40 });
  assert.deepEqual(lines[1].red, ["lint"]);
  assert.equal(lines[2].red, undefined);
});

test("the slot wait of a landing gate is `waitMs`, not part of its `ms`", async () => {
  const timings = join(TMP, "wait.jsonl");
  // The whole call is the wait, measured inside it: a fixed sleep and margin failed under load,
  // when the timer itself overran the margin.
  let wait = 0;
  await timedLandingGate(timings, { run: "r1", project: "fixture", issue: "7" }, async () => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 30));
    wait = Date.now() - start;
    return { gates: [], waitMs: wait };
  });
  const l = JSON.parse(readFileSync(timings, "utf8"));
  assert.equal(l.waitMs, wait);
  assert.ok(l.ms < l.waitMs, `ms ${l.ms} holds the wait (${l.waitMs})`);
});

test("typicalTimes: the landing gates are a figure of their own, and no part of an issue's time", () => {
  const typical = typicalTimes(project());
  assert.equal(typical.issue, 10 * 60);
  assert.equal(typical[LANDING_GATES], 5 * 60);
  // Without a landing line there is no key, and the issue is as before.
  const without = typicalTimes(project([], null));
  assert.equal(without.issue, 10 * 60);
  assert.equal(LANDING_GATES in without, false);
});

test("typicalTimes: a ticket that landed without a gate counts none, so the median follows the tickets", () => {
  // One of three tickets has a landing gate: the median ticket has none.
  const root = mkdtempSync(join(TMP, "estimate-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = ["1", "2", "3"].flatMap((issue) => [line({ issue, phase: "implement", ms: MIN, tokens }), ...(issue === "1" ? [line({ issue, phase: LANDING_GATES, ms: 5 * MIN })] : [])]);
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  assert.equal(typicalTimes({ root, name: "fixture" } as Project)[LANDING_GATES], 0);
});

test("18 tickets, 9 sandboxes: the landings in a row set the time, whatever the gate slots", () => {
  const p = project();
  // Sandbox-bound: 2 rounds of 10m. Landings: 18 x 5m on one worker.
  assert.match(estimate(p, 18, 9)!, /and 1h 30m for 18 ticket\(s\), 9 at a time \(landing gates, one after another, set the time\)\.$/);
  assert.match(estimate(p, 18, 9, 0, undefined, { gateSlots: 100 })!, /and 1h 30m for 18 ticket\(s\), 9 at a time \(landing gates, one after another/);
});

test("the landing gates share the gates pool with the tickets' own passes", () => {
  const p = project();
  // (18 x 6m + 18 x 5m) over 2 slots is 99m, above the 90m of landings in a row.
  assert.match(estimate(p, 18, 9, 0, undefined, { gateSlots: 2 })!, /and 1h 39m for 18 ticket\(s\), 9 at a time \(gate runs on 2 slot\(s\) set the time\)\.$/);
});

test("a landing gate is no part of the ticket's own pipeline time, and a history without one is as before", () => {
  const p = project();
  // 3 tickets, 3 slots: one round of 10m; the 3 landings take 15m.
  assert.match(estimate(p, 3, 3)!, /and 15m for 3 ticket\(s\), 3 at a time \(landing/);
  const bare = project([], null);
  assert.match(estimate(bare, 18, 9)!, /and 20m for 18 ticket\(s\), 9 at a time\.$/);
});

// The status view: one sandbox, one ticket in it, two queued.
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
const now = Math.floor(Date.now() / 1000);
const record = (typical: Record<string, number>) =>
  writeFileSync(
    join(LOGS, "run.json"),
    JSON.stringify({
      orchestrator: "fixture",
      pid: live.pid,
      startedAt: new Date((now - 60) * 1000).toISOString(),
      models: "m",
      stage: "running",
      concurrency: 3,
      typical,
      issues: ["1", "2", "3"],
      tickets: {
        "1": { state: "implement", since: now, started: now },
        "2": { state: "queued", order: 2, since: now },
        "3": { state: "queued", order: 3, since: now },
      },
    }),
  );
const ends = () => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: [FAKE, process.env.PATH].join(":"),
    SANDCASTLE_PROJECT: REPO,
    SANDCASTLE_BIN: join(FAKE, "sandcastle"),
    SANDCASTLE_BASE: "main",
    SANDCASTLE_NAME: "fixture",
    TERM_COLS: "120",
    TERM_ROWS: "200",
    XDG_CACHE_HOME: join(TMP, "cache"),
  };
  delete env.SANDCASTLE_SETTINGS;
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(import.meta.dirname, "..", "status.sh"), "0", "all"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const text = r.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => /\bends +~/.test(l)) ?? "";
  const m = /ends +~(\d\d):(\d\d)/.exec(text);
  assert.ok(m, `no ends line in: ${r.stdout}`);
  // Minutes from now to the shown end, across midnight.
  const d = new Date();
  return ((Number(m[1]) * 60 + Number(m[2]) - (d.getHours() * 60 + d.getMinutes())) + 1440) % 1440;
};

test("status: ends ~HH:MM is the pipelines' end, or the landings in a row when they are later", () => {
  // Three sandboxes: the pipelines end in about 10m (one typical ticket's length).
  record({ issue: 600 });
  const pipelines = ends();
  assert.ok(pipelines >= 9 && pipelines <= 11, `pipelines end in ${pipelines}m`);
  // Three tickets not yet landed, 20m of landing gates each, on one worker: an hour.
  record({ issue: 600, [LANDING_GATES]: 1200 });
  const landings = ends();
  assert.ok(landings >= 59 && landings <= 61, `landings end in ${landings}m`);
  // A short landing gate sets no floor above the pipelines.
  record({ issue: 600, [LANDING_GATES]: 60 });
  const short = ends();
  assert.ok(short >= 9 && short <= 11, `short landings end in ${short}m`);
});
