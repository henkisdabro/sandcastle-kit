// The closing summary sets a run's time and tokens beside its start estimate when they are more than twice off, names the
// largest causes the record can measure when the run was slow, and lists a likely flaky test (`flaked` or `flaky` on a
// ticket's record) once, with the tickets it hit. Made-up facts and timings lines; no Docker, model or network.
//
//   pnpm test:file test/report-slow-run.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Facts, render, timeLostFromTimings } from "../src/report.ts";

const MIN = 60_000;

const facts = (over: Partial<Facts> = {}): Facts => ({
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:00:00.000Z",
  finished: "2026-09-30T11:00:00.000Z",
  live: false,
  dryRun: false,
  verify: null,
  gateCount: 2,
  tickets: {},
  runnable: [],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
  ...over,
});

// 5 hours against an hour; 90M tokens in against 20M, 1.2M out against 400k.
const estimate = { ms: { mid: 60 * MIN, high: 90 * MIN }, tokensIn: { mid: 20_000_000, high: 30_000_000 }, tokensOut: { mid: 400_000, high: 600_000 }, slots: 2, tickets: 4 };
const tokenTotal = { input: 1_000_000, cacheWrite: 4_000_000, cacheRead: 85_000_000, output: 1_200_000 };

const headline = (out: string) => out.split("\n").filter((l) => /^(Against the estimate|Largest causes|No cause measured)/.test(l));

test("a run that took five times its estimate gives both, with the tokens", () => {
  const [line] = headline(render(facts({ estimate, tokenTotal })));
  assert.equal(line, "Against the estimate: 5h 00m against an estimate of 1h 00m (5.0x); tokens 90.0M in / 1.2M out against an estimate of 20.0M in / 400k out (4.5x).");
});

test("the largest causes the record measured are named, largest first, and anything under a minute is left out", () => {
  const out = render(
    facts({
      estimate,
      tokenTotal,
      sharedMs: 180 * MIN,
      sandboxWaitMs: 20 * MIN,
      timeLost: { gateWaitMs: 55 * MIN, landingWaitMs: 4 * MIN, reruns: 3, rerunMs: 12 * MIN, repairs: 1, repairMs: 8 * MIN },
    }),
  );
  assert.deepEqual(headline(out).slice(1), [
    "Largest causes measured: 3h 00m at a share below what it asked for, beside another run; 55m waiting for gates slots, summed over tickets; 20m with a worker waiting for a sandbox slot; 3 gate re-runs and 1 repair pass (20m of pass time); 4m with landings waiting for a sandbox slot.",
  ]);
  const small = render(facts({ estimate, sharedMs: 30_000, timeLost: { gateWaitMs: 0, landingWaitMs: 0, reruns: 0, rerunMs: 0, repairs: 0, repairMs: 0 } }));
  assert.match(headline(small)[1], /^No cause measured/);
});

test("a run within twice its estimate says nothing of it, unless one cause took a fifth of its time or more", () => {
  const within = { estimate: { ...estimate, ms: { mid: 180 * MIN, high: 240 * MIN } }, tokenTotal: { input: 1, cacheWrite: 0, cacheRead: 30_000_000, output: 600_000 } };
  assert.deepEqual(headline(render(facts({ ...within, sharedMs: 59 * MIN }))), []);
  // 3 of its 5 hours beside another run: the operator is told, though the run was inside twice its estimate.
  assert.deepEqual(headline(render(facts({ ...within, sharedMs: 3 * 60 * MIN }))), ["Largest causes measured: 3h 00m at a share below what it asked for, beside another run."]);
});

test("a run bound by its gates slot names the check that says whether the machine has room for more", () => {
  const within = { estimate: { ...estimate, ms: { mid: 180 * MIN, high: 240 * MIN } }, tokenTotal: { input: 1, cacheWrite: 0, cacheRead: 30_000_000, output: 600_000 } };
  const timeLost = { gateWaitMs: 4 * 60 * MIN, landingWaitMs: 0, reruns: 0, rerunMs: 0, repairs: 0, repairMs: 0 };
  assert.deepEqual(headline(render(facts({ ...within, timeLost }))), [
    "Largest causes measured: 4h 00m waiting for gates slots, summed over tickets. `sandcastle size` says whether the machine has room for more gates slots.",
  ]);
});

test("a run that took half its estimate or less gives the estimate, and causes only when one is large", () => {
  const fast = { estimate: { ...estimate, ms: { mid: 11 * 60 * MIN, high: 12 * 60 * MIN } } };
  assert.deepEqual(headline(render(facts({ ...fast, sharedMs: 30 * MIN }))), ["Against the estimate: 5h 00m against an estimate of 11h 00m (0.5x)."]);
  assert.deepEqual(headline(render(facts({ ...fast, sharedMs: 3 * 60 * MIN }))), [
    "Against the estimate: 5h 00m against an estimate of 11h 00m (0.5x).",
    "Largest causes measured: 3h 00m at a share below what it asked for, beside another run.",
  ]);
});

test("tokens alone more than twice off give the line, with no causes for a run on time", () => {
  const out = render(facts({ estimate: { ...estimate, ms: { mid: 4 * 60 * MIN, high: 5 * 60 * MIN } }, tokenTotal }));
  assert.equal(headline(out).length, 1);
  assert.match(headline(out)[0], /tokens 90\.0M in .* \(4\.5x\)\.$/);
});

test("tokens far under the estimate give their ratio, as a run far over it does", () => {
  const out = render(facts({ estimate: { ...estimate, ms: { mid: 4 * 60 * MIN, high: 5 * 60 * MIN } }, tokenTotal: { input: 1, cacheWrite: 0, cacheRead: 8_000_000, output: 100_000 } }));
  assert.match(headline(out)[0], /against an estimate of 20\.0M in \/ 400k out \(0\.4x\)\.$/);
});

test("a run with no estimate, a live run and a dry run give no line", () => {
  assert.deepEqual(headline(render(facts({ tokenTotal }))), []);
  assert.deepEqual(headline(render(facts({ estimate, live: true, finished: undefined }))), []);
  assert.deepEqual(headline(render(facts({ estimate, dryRun: true }))), []);
});

const flakyLine = (out: string) => out.split("\n").filter((l) => l.startsWith("Likely flaky"));
const FLAKY = "Likely flaky - red, then green on a re-run, or judged flaky by a repair pass: ";

test("a test red then green on a re-run is listed once with every ticket it hit", () => {
  const out = render(
    facts({
      tickets: {
        "11": { state: "merged", title: "a", flaked: ["test/pool.test.ts", "test/a.test.ts"] },
        "12": { state: "merged", title: "b", flaked: ["test/pool.test.ts"] },
        "13": { state: "merged", title: "c", flaked: ["test/pool.test.ts", "test/pool.test.ts"] },
      },
    }),
  );
  assert.deepEqual(flakyLine(out), [`${FLAKY}test/pool.test.ts (#11, #12, #13); test/a.test.ts (#11).`]);
});

test("the in-slot re-run's flakes and a repair verdict's flaky tests are one list, each test once", () => {
  const out = render(
    facts({
      tickets: {
        "21": { state: "merged", title: "a", flaked: ["test/pool.test.ts::takes a slot"] },
        "22": { state: "red", title: "b", flaky: ["test/clock.test.ts::ticks"] },
        "23": { state: "merged", title: "c", flaked: ["test/clock.test.ts::ticks"], flaky: ["test/clock.test.ts::ticks"] },
      },
    }),
  );
  assert.deepEqual(flakyLine(out), [`${FLAKY}test/clock.test.ts::ticks (#22, #23); test/pool.test.ts::takes a slot (#21).`]);
});

test("no ticket with a flaky test, no line", () => {
  assert.equal(render(facts({ tickets: { "1": { state: "merged", title: "a" } } })).includes("Likely flaky"), false);
});

const line = (over: Record<string, unknown>) => JSON.stringify({ run: "r1", ms: 1000, ok: true, ...over });

test("the timings lines give the gates slot waits, the landings' sandbox slot waits apart, the gate re-runs and the repair passes of the run", () => {
  const text = [
    line({ issue: "", phase: "base gates", ms: 5000, waitMs: 2 * MIN }),
    line({ issue: "1", phase: "setup", ms: 4000, waitMs: 9 * MIN }),
    line({ issue: "1", phase: "gates", ms: 3 * MIN, waitMs: 20 * MIN }),
    line({ issue: "1", phase: "gates", ms: 4 * MIN, waitMs: 5 * MIN }),
    line({ issue: "1", phase: "repair", ms: 6 * MIN }),
    line({ issue: "1", phase: "gates", ms: 2 * MIN }),
    line({ issue: "2", phase: "gates", ms: 3 * MIN }),
    line({ issue: "1", phase: "landing", ms: 1000, waitMs: 3 * MIN }),
    line({ run: "r0", issue: "1", phase: "gates", ms: 99 * MIN, waitMs: 99 * MIN }),
    "not json",
  ].join("\n");
  assert.deepEqual(timeLostFromTimings(text, "r1"), { gateWaitMs: 27 * MIN, landingWaitMs: 3 * MIN, reruns: 2, rerunMs: 6 * MIN, repairs: 1, repairMs: 6 * MIN });
  assert.equal(timeLostFromTimings(text, "none"), undefined);
});

test("a landing gate's marked re-run line counts as one gate re-run, and a ticket's in-slot gates re-run line once", () => {
  const text = [
    line({ issue: "1", phase: "gates", ms: 3 * MIN }),
    line({ issue: "1", phase: "gates", ms: 4 * MIN, rerun: true }),
    line({ issue: "1", phase: "landing gates", ms: 2 * MIN, ok: false }),
    line({ issue: "1", phase: "landing gates", ms: 1 * MIN, rerun: true }),
    // A requeued ticket's second landing has no mark and is no re-run.
    line({ issue: "1", phase: "landing gates", ms: 5 * MIN }),
  ].join("\n");
  assert.deepEqual(timeLostFromTimings(text, "r1"), { gateWaitMs: 0, landingWaitMs: 0, reruns: 2, rerunMs: 5 * MIN, repairs: 0, repairMs: 0 });
});

test("a ticket whose landing gate flaked is listed under Likely flaky", () => {
  const out = render(facts({ tickets: { "31": { state: "merged", title: "a", flaked: ["test/clock.test.ts::ticks"] } } }));
  assert.deepEqual(flakyLine(out), [`${FLAKY}test/clock.test.ts::ticks (#31).`]);
});
