// LOAD_PAUSE: a run holds each gate pass, before it takes its gates slot, while the machine's CPU pressure is high
// (src/load-pause.ts). The hold runs here on a fake clock, a fake sleep and a fake reader; the gate side through
// `runGates` on a fake sandbox. No Docker, no model calls.
//
//   pnpm test:file test/load-pause.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunSettings } from "../mod/hooks/run-record.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createLoadPause, loadPauseLine, loadRecord, parseLoadPause } = await import("../src/load-pause.ts");
const { loadProject } = await import("../src/config.ts");
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");
const { runGates, setLoadHold, stepTimes, timingLines } = await import("../src/gates.ts");
const { render } = await import("../src/report.ts");
type Facts = Parameters<typeof render>[0];
type Reading = { avg10: number; avg60: number; estimate?: true } | undefined;

const MIN = 60_000;

// A clock that moves only when a sleep is fired: `drive` fires the earliest sleeping timer until the promise settles.
const world = () => {
  let time = 1_000_000;
  const timers: { at: number; wake: () => void }[] = [];
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    now: () => time,
    sleep: (ms: number) => new Promise<void>((resolve) => timers.push({ at: time + ms, wake: resolve })),
    async drive(...promises: Promise<unknown>[]) {
      let settled = 0;
      const all = Promise.all(promises).then(() => void settled++);
      for (let i = 0; i < 10_000 && !settled; i++) {
        await flush();
        if (settled) break;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        if (!next) continue;
        time = Math.max(time, next.at);
        next.wake();
      }
      await all;
    },
  };
};

const pressure = (avg60: number, estimate?: true): NonNullable<Reading> => ({ avg10: avg60, avg60, ...(estimate ? { estimate } : {}) });

test("parseLoadPause: 60 by default, LOAD_PAUSE=0 and loadPause: false are off, the environment beats the config", () => {
  assert.equal(parseLoadPause(undefined), 60);
  assert.equal(parseLoadPause(""), 60);
  assert.equal(parseLoadPause(undefined, undefined), 60);
  assert.equal(parseLoadPause("0"), undefined);
  assert.equal(parseLoadPause(undefined, false), undefined);
  assert.equal(parseLoadPause("75", 40), 75);
  assert.equal(parseLoadPause(undefined, 40), 40);
  assert.equal(parseLoadPause("0", 40), undefined);
  assert.equal(parseLoadPause("1"), 1);
  assert.equal(parseLoadPause("100"), 100);
});

test("parseLoadPause refuses a value outside 1 to 100, naming the key", () => {
  assert.throws(() => parseLoadPause("150"), /LOAD_PAUSE=150.*0 \(off\) or 1 to 100/);
  assert.throws(() => parseLoadPause("abc"), /LOAD_PAUSE=abc/);
  assert.throws(() => parseLoadPause("-5"), /LOAD_PAUSE=-5/);
  assert.throws(() => parseLoadPause(undefined, 0), /loadPause=0 in the project config/);
  assert.throws(() => parseLoadPause(undefined, 101), /loadPause=101/);
  assert.throws(() => parseLoadPause(undefined, "high"), /loadPause="high"/);
  assert.throws(() => parseLoadPause(undefined, true), /loadPause=true/);
});

test("a project's loadPause is refused as usagePause is, naming the key and the value", async () => {
  // One project root per value: the config module is cached by path.
  const project = (value: string) => {
    const root = mkdtempSync(join(tmpdir(), "sandcastle-load-pause-"));
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(join(root, ".sandcastle", "config.ts"), `export default { name: "demo", loadPause: ${value}, gates: [{ name: "t", command: "true" }] };\n`);
    return root;
  };
  await assert.rejects(() => loadProject(project("0")), /`loadPause` must be false \(off\) or a number from 1 to 100.*not 0/);
  await assert.rejects(() => loadProject(project("150")), /`loadPause` must be.*not 150/);
  await assert.rejects(() => loadProject(project('"high"')), /`loadPause` must be.*not "high"/);
  await assert.rejects(() => loadProject(project("true")), /`loadPause` must be.*not true/);
  assert.equal((await loadProject(project("false"))).loadPause, false);
  assert.equal((await loadProject(project("40"))).loadPause, 40);
});

test("hold returns at once under the threshold and with no reading", async () => {
  const w = world();
  const said: string[] = [];
  const pause = createLoadPause({ threshold: 60, read: () => pressure(59.9), now: w.now, sleep: w.sleep, say: (l) => said.push(l) });
  let begun = false;
  await pause.hold("ticket gates", () => (begun = true));
  assert.equal(begun, false);
  assert.equal(said.length, 0);
  const blind = createLoadPause({ threshold: 60, read: (): Reading => undefined, now: w.now, sleep: w.sleep, say: (l) => said.push(l) });
  await blind.hold("ticket gates");
  assert.equal(w.now(), 1_000_000, "no time passed");
  assert.equal(pause.heldMs(), 0);
});

test("hold waits at 70%, says why once, and releases after 2 minutes under the threshold", async () => {
  const w = world();
  const start = w.now();
  const said: string[] = [];
  let begun = 0;
  // Busy for the first minute, then quiet.
  const pause = createLoadPause({ threshold: 60, read: () => pressure(w.now() - start < MIN ? 70 : 20), now: w.now, sleep: w.sleep, say: (l) => said.push(l) });
  await w.drive(pause.hold("#7 gates", () => begun++));
  assert.equal(begun, 1, "onHold once");
  assert.equal(said.length, 1);
  assert.equal(said[0], "Load pause: the machine's CPU pressure is 70% (some avg60, at or over 60%) - #7 gates waits until it is under 60% for 2 minutes");
  const held = w.now() - start;
  assert.ok(held >= 3 * MIN && held <= 3 * MIN + 10_000, `held ${held} ms: the minute busy and the 2 minutes quiet`);
  assert.equal(pause.heldMs(), held);
  assert.equal(pause.gaveUp(), false);
});

test("a reading at the threshold inside the 2 minutes restarts them", async () => {
  const w = world();
  const start = w.now();
  // Quiet from 10 s, a spike at 60% at 90 s, quiet again after.
  const read = () => {
    const t = w.now() - start;
    return pressure(t < 10_000 ? 70 : t >= 90_000 && t < 100_000 ? 60 : 10);
  };
  const pause = createLoadPause({ threshold: 60, read, now: w.now, sleep: w.sleep, say: () => {} });
  await w.drive(pause.hold("gates"));
  const held = w.now() - start;
  assert.ok(held >= 100_000 + 2 * MIN, `held ${held} ms: 2 minutes counted again from the spike`);
  assert.ok(held <= 100_000 + 2 * MIN + 10_000);
});

test("the macOS estimate is named in the hold's line", async () => {
  const w = world();
  const said: string[] = [];
  let busy = true;
  const pause = createLoadPause({ threshold: 60, read: () => pressure(busy ? 80 : 0, true), now: w.now, sleep: w.sleep, say: (l) => said.push(l) });
  const start = w.now();
  const held = pause.hold("the verify");
  w.sleep(0);
  busy = false;
  await w.drive(held);
  assert.match(said[0], /80% \(some avg60, an estimate from the load average, at or over 60%\) - the verify waits/);
  assert.ok(w.now() - start >= 2 * MIN);
});

test("a read that gives no reading releases the hold", async () => {
  const w = world();
  const start = w.now();
  const pause = createLoadPause({ threshold: 60, read: () => (w.now() - start < 30_000 ? pressure(90) : undefined), now: w.now, sleep: w.sleep, say: () => {} });
  await w.drive(pause.hold("gates"));
  assert.ok(w.now() - start <= 40_000, "released as soon as the machine could not be read");
});

test("two holds at once count their shared time once", async () => {
  const w = world();
  const start = w.now();
  const pause = createLoadPause({ threshold: 60, read: () => pressure(w.now() - start < 5 * MIN ? 90 : 5), now: w.now, sleep: w.sleep, say: () => {} });
  await w.drive(pause.hold("a"), pause.hold("b"));
  const wall = w.now() - start;
  assert.ok(wall >= 7 * MIN && wall <= 7 * MIN + 10_000, `both released after ${wall} ms`);
  assert.equal(pause.heldMs(), wall, "the wall time, not twice it");
  // A hold later adds its own time to the total.
  const before = pause.heldMs();
  const again = createLoadPause({ threshold: 60, read: () => pressure(5), now: w.now, sleep: w.sleep, say: () => {} });
  await again.hold("c");
  assert.equal(pause.heldMs(), before);
});

test("at 30 minutes held in all, every hold releases at once and the run holds nothing again", async () => {
  const w = world();
  const start = w.now();
  const said: string[] = [];
  const changes: { heldMs: number; gaveUp: boolean }[] = [];
  const pause = createLoadPause({ threshold: 60, read: () => pressure(90), now: w.now, sleep: w.sleep, say: (l) => said.push(l), onChange: (c) => changes.push(c) });
  await w.drive(pause.hold("a"), pause.hold("b"));
  assert.equal(w.now() - start, 30 * MIN, "released at the 30 minutes exactly");
  assert.equal(pause.gaveUp(), true);
  assert.equal(pause.heldMs(), 30 * MIN);
  assert.deepEqual(said.filter((l) => /giving up/.test(l)), ["Load pause: held gate passes 30 minutes in all - giving up; later gate passes run under load"]);
  assert.deepEqual(changes.at(-1), { heldMs: 30 * MIN, gaveUp: true });
  // Later holds return at once, at 90% too.
  const at = w.now();
  await pause.hold("c");
  assert.equal(w.now(), at);
  assert.equal(pause.heldMs(), 30 * MIN);
});

test("a hold's time across several passes adds up to the give-up", async () => {
  const w = world();
  let busy = true;
  const pause = createLoadPause({ threshold: 60, read: () => pressure(busy ? 90 : 5), now: w.now, sleep: w.sleep, say: () => {} });
  // 25 minutes busy then quiet for the 2 minutes: 27 minutes held.
  const start = w.now();
  const first = pause.hold("a");
  const stop = w.sleep(25 * MIN).then(() => (busy = false));
  await w.drive(first, stop);
  const spent = pause.heldMs();
  assert.ok(spent >= 27 * MIN && spent < 28 * MIN, `${spent} ms after the first`);
  busy = true;
  await w.drive(pause.hold("b"));
  assert.equal(pause.gaveUp(), true);
  assert.equal(pause.heldMs(), 30 * MIN, "the second hold had only what was left");
  assert.ok(w.now() - start < 30 * MIN + 10_000);
});

test("onChange gets the running total while holding, at the release, and gaveUp at the give-up", async () => {
  const w = world();
  const start = w.now();
  const changes: { heldMs: number; gaveUp: boolean }[] = [];
  const pause = createLoadPause({ threshold: 60, read: () => pressure(w.now() - start < 30_000 ? 90 : 0), now: w.now, sleep: w.sleep, say: () => {}, onChange: (c) => changes.push(c) });
  await w.drive(pause.hold("a"));
  assert.ok(changes.length >= 3, "while holding, once per poll at most");
  assert.ok(changes.length <= 15, "not once per read of two polls");
  for (let i = 1; i < changes.length; i++) assert.ok(changes[i].heldMs > changes[i - 1].heldMs, "a change only when the total changed");
  assert.deepEqual(changes.at(-1), { heldMs: pause.heldMs(), gaveUp: false });
  assert.ok(changes.every((c) => !c.gaveUp));

  // A listener set later takes over from the constructor's.
  const heard: unknown[] = [];
  const next = createLoadPause({ threshold: 60, read: () => pressure(90), now: w.now, sleep: w.sleep, say: () => {}, giveUpMs: 5 * MIN, onChange: () => assert.fail("replaced") });
  next.listen((c) => heard.push(c));
  await w.drive(next.hold("a"));
  assert.deepEqual(heard.at(-1), { heldMs: 5 * MIN, gaveUp: true });
  assert.deepEqual(loadRecord({ heldMs: 5 * MIN, gaveUp: true }), { heldMs: 5 * MIN, gaveUp: true });
  assert.deepEqual(loadRecord({ heldMs: 7, gaveUp: false }), { heldMs: 7 });
});

test("the start line names the threshold, the limit and the off switch, the estimate, and a machine with no reading", () => {
  const line = loadPauseLine(60, pressure(3));
  assert.match(line, /at or over 60% \(some avg60\), 30 minutes in all per run; LOAD_PAUSE=0 turns it off/);
  assert.doesNotMatch(line, /estimate/);
  assert.match(loadPauseLine(60, pressure(3, true)), /an estimate from the load average/);
  assert.match(loadPauseLine(60, undefined), /gives no CPU pressure reading, so the run never holds/);
});

// ---------------------------------------------------------------------------
// The gate side: `runGates` on a fake sandbox, held through `setLoadHold`.
// ---------------------------------------------------------------------------

const gateProject = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }, { name: "test", command: "run-test" }] } as Parameters<typeof runGates>[0];

// The real clock is mocked (`runGates` takes its wait from `Date.now()`); the fake sandbox runs a gate in 5 s of it.
const fakeBox = (t: { mock: { timers: { tick(ms: number): void } } }, ran: string[]) => ({
  exec: async (cmd: string) => {
    if (cmd.includes("run-")) {
      ran.push(cmd);
      t.mock.timers.tick(5_000);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  },
});

// A hold whose reader is 70% until `quietAt` (ms after the start) and 10% after, on the mocked `Date`, sleeping by moving it.
const mockedHold = (t: Parameters<typeof fakeBox>[0], quietAt: number) => {
  const start = Date.now();
  const said: string[] = [];
  const pause = createLoadPause({
    threshold: 60,
    read: () => pressure(Date.now() - start < quietAt ? 70 : 10),
    now: () => Date.now(),
    sleep: async (ms) => t.mock.timers.tick(ms),
    say: (l) => said.push(l),
  });
  return { pause, said };
};

test("runGates holds a pass until the machine is quiet for 2 minutes, then runs its gates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const ran: string[] = [];
  const box = fakeBox(t, ran);
  const { pause, said } = mockedHold(t, MIN);
  let started = 0;
  let waits = 0;
  setLoadHold(async (label, onHold) => {
    assert.equal(ran.length, 0, "no gate has run when the hold begins");
    await pause.hold(label, onHold);
    assert.equal(ran.length, 0, "and none ran during it");
  });
  t.after(() => setLoadHold(undefined));
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-load-pause-")), "gates.log");
  const run = await runGates(gateProject, box, "fixture ticket", false, { log, loadWait: () => started++, wait: () => waits++ });
  assert.equal(started, 1, "loadWait once");
  assert.equal(waits, 0, "no gates slot wait");
  assert.deepEqual(ran.map((c) => c.includes("lint") || c.includes("test")), [true, true]);
  assert.ok(run.loadHeldMs !== undefined && run.loadHeldMs >= 3 * MIN && run.loadHeldMs <= 3 * MIN + 10_000, `held ${run.loadHeldMs}`);
  assert.equal(run.loadHeldMs, pause.heldMs(), "the run's held total is this pass's hold");
  assert.equal(run.waitMs, 0, "the hold is no part of the slot wait");
  assert.equal(run.gates[0].ms, 5_000);
  assert.equal(said.length, 1);
  const text = readFileSync(log, "utf8");
  assert.match(text, new RegExp(`# held ${Math.round(run.loadHeldMs! / 1000)}s for machine load\n`));
  assert.doesNotMatch(text, /# waited/);
});

test("a base or verify pass (all gates, its own slot, a log) is held the same way", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const ran: string[] = [];
  const { pause } = mockedHold(t, 30_000);
  t.after(() => setLoadHold(undefined));
  const log = join(mkdtempSync(join(tmpdir(), "sandcastle-load-pause-")), "base.log");
  const labels: string[] = [];
  setLoadHold(async (label, onHold) => {
    labels.push(label);
    await pause.hold(label, onHold);
  });
  const run = await runGates(gateProject, fakeBox(t, ran), "fixture base-red", true, { log }, true);
  assert.deepEqual(labels, ["fixture base-red"]);
  assert.equal(ran.length, 2);
  assert.ok((run.loadHeldMs ?? 0) >= 2 * MIN, "held");
  assert.equal(run.waitMs, 0);
  const text = readFileSync(log, "utf8");
  assert.match(text, /# held \d+s for machine load/);
  assert.doesNotMatch(text, /# waited/);
});

test("a pass is held by the machine's load once: the red gate's re-run in the same slot asks again for nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let calls = 0;
  let gate = 0;
  setLoadHold(async () => void calls++);
  t.after(() => setLoadHold(undefined));
  const box = {
    exec: async (cmd: string) => {
      if (cmd.includes("run-")) t.mock.timers.tick(1_000);
      // The test gate is red the first time it runs.
      const red = cmd.includes("run-test") && gate++ === 0;
      return { exitCode: red ? 1 : 0, stdout: "", stderr: "" };
    },
  };
  const run = await runGates(gateProject, box, "fixture ticket", false, {}, false, undefined, true);
  assert.ok(run.rerunOf, "the red gate ran again");
  assert.equal(calls, 1, "one hold for the pass and its re-run");
});

test("with no hold set, or a machine that reads quiet, a pass has no loadHeldMs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  setLoadHold(undefined);
  const plain = await runGates(gateProject, fakeBox(t, []), "fixture");
  assert.equal("loadHeldMs" in plain, false);
  const pause = createLoadPause({ threshold: 60, read: () => pressure(1), now: () => Date.now(), sleep: async () => {}, say: () => {} });
  setLoadHold(pause.hold);
  t.after(() => setLoadHold(undefined));
  const quiet = await runGates(gateProject, fakeBox(t, []), "fixture");
  assert.equal("loadHeldMs" in quiet, false);
});

test("stepTimes takes the hold out of ms, beside the slot wait", () => {
  assert.deepEqual(stepTimes(700_000, { gates: [], waitMs: 100_000, loadHeldMs: 400_000 }), { ms: 200_000, waitMs: 100_000, loadHeldMs: 400_000 });
  assert.deepEqual(stepTimes(700_000, { loadHeldMs: 400_000 }), { ms: 300_000, loadHeldMs: 400_000 });
  assert.deepEqual(stepTimes(5_000, { loadHeldMs: 0 }), { ms: 5_000 });
  assert.deepEqual(stepTimes(1_000, { waitMs: 600, loadHeldMs: 9_000 }), { ms: 0, waitMs: 600, loadHeldMs: 400 });
});

test("timingLines puts loadHeldMs on the first run's line only", () => {
  const first = { gates: [{ name: "test", pass: false, ms: 20_000 }], failures: [], waitMs: 3_000, ms: 20_000 };
  const result = { gates: [{ name: "test", pass: true, ms: 15_000 }], failures: [], waitMs: 3_000, loadHeldMs: 90_000, rerunOf: first };
  const line = { ms: 35_000, waitMs: 3_000, loadHeldMs: 90_000, phase: "gates" };
  const lines = timingLines(line, result);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].loadHeldMs, 90_000);
  assert.equal(lines[0].waitMs, 3_000);
  assert.equal("loadHeldMs" in lines[1], false);
  assert.equal("waitMs" in lines[1], false);
  assert.equal(lines[0].ms, 20_000);
  assert.equal(lines[1].ms, 15_000);
});

// ---------------------------------------------------------------------------
// Settings, the record and the closing summary.
// ---------------------------------------------------------------------------

const resolve = (env: Record<string, string | undefined>, project: { loadPause?: unknown } = {}) => resolveSettings({ env, project, machine: {} });

test("the resolved settings and the settings group carry loadPause 60 by default, and none when it is off", () => {
  assert.equal(resolve({}).loadPause, 60);
  assert.equal(settingsGroup(resolve({}), 1).loadPause, 60);
  assert.equal(resolve({ LOAD_PAUSE: "75" }, { loadPause: 40 }).loadPause, 75);
  assert.equal(resolve({}, { loadPause: 40 }).loadPause, 40);
  for (const off of [resolve({ LOAD_PAUSE: "0" }), resolve({}, { loadPause: false })]) {
    assert.equal("loadPause" in off, false);
    assert.equal("loadPause" in settingsGroup(off, 1), false);
  }
  assert.throws(() => resolve({ LOAD_PAUSE: "abc" }), /LOAD_PAUSE/);
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  verify: { green: true, line: "ok" },
  gateCount: 2,
  tickets: { "7": { state: "merged", title: "a" } },
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

const settings = (over: Partial<RunSettings> = {}): RunSettings => ({ autonomy: 0, turn: 1, cap: 1, crossReview: false, usageGuard: false, ...over });

test("the Settings line names the load pause when the run's settings carry one", () => {
  const out = render(facts({ settings: settings({ loadPause: 60 }) }));
  assert.match(out.split("\n").find((l) => l.startsWith("Settings:")) ?? "", /usage guard off · load pause at 60%/);
  assert.doesNotMatch(render(facts({ settings: settings() })), /load pause at/);
});

test("the summary says how long gate passes waited for the machine, and that the run gave up", () => {
  const held = render(facts({ settings: settings({ loadPause: 60 }), loadPause: { heldMs: 600_000 } }));
  assert.match(held, /^Load pause: gate passes waited 10m in all for the machine's CPU pressure \(at or over 60%, some avg60\)$/m);
  assert.doesNotMatch(held, /gave up/);
  const gaveUp = render(facts({ settings: settings({ loadPause: 60 }), loadPause: { heldMs: 1_800_000, gaveUp: true } }));
  assert.match(gaveUp, /^Load pause: gate passes waited 30m in all for the machine's CPU pressure \(at or over 60%, some avg60\) - gave up after 30 min, so later gate passes ran under load$/m);
  assert.doesNotMatch(render(facts({ loadPause: { heldMs: 0 } })), /Load pause:/);
  assert.doesNotMatch(render(facts()), /Load pause:/);
});

// ---------------------------------------------------------------------------
// The wiring `burndown()` and the run loop have no harness for: held by source.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the run loop makes one load pause for the run, and burndown sets, records and clears it", () => {
  const cli = read("src/cli.ts");
  assert.match(cli, /settings\.loadPause === undefined\s*\?\s*undefined\s*:\s*createLoadPause\(/);
  assert.match(cli, /burndown\(project, \{ settings, turn, [^\n]*loadPause \? \{ loadPause \} : \{\}/);
  const burndown = read("src/burndown.ts");
  assert.match(burndown, /pause\.listen\(\(change\) => run\.update\(\{ loadPause: loadRecord\(change\) \}\)\);\s*setLoadHold\(pause\.hold\);/);
  assert.match(burndown, /\.\.\.\(turn\?\.loadPause \? \{ loadPause: loadRecord\(/, "every turn's record carries the running total from its start");
  assert.match(burndown, /finally \{[^}]*setLoadHold\(undefined\);[^}]*listen\(undefined\)/, "cleared when the turn ends, a throw included");
  assert.match(burndown, /loadWait: \(\) => \{[\s\S]*?waiting: machine load[\s\S]*?if \(!priority\) gateWaits\.get\(id\)\?\.\(\);/, "a ticket's own gates free its sandbox slot, as a slot wait does");
  assert.ok(existsSync(new URL("../src/load-pause.ts", import.meta.url)));
});
