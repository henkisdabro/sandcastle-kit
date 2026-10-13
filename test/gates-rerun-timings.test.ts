// A red ticket gate re-run inside its slot (`rerunOnRed`) is one gate step, but its timings are the two runs' lines,
// as when each run leased its own slot: one line for both read as a single green pass, so the ticket card lost the
// run that went red and the closing summary lost the memory pressure read while it did. No Docker, model or network.
//
//   pnpm test:file test/gates-rerun-timings.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup } from "./pool-sim.ts";

const { runGates, timingLines, stepTimes } = await import("../src/gates.ts");
const { ticketPasses, pressureFromTimings } = await import("../src/report.ts");

afterEach(cleanup);

const CONFIGURED = [
  { name: "lint", command: "run-lint" },
  { name: "test", command: "run-tests" },
];
const project = { name: "fixture", gates: CONFIGURED } as Parameters<typeof runGates>[0];

/** A sandbox whose `test` gate is red on its first run only. */
const flaky = () => {
  let red = 1;
  return {
    exec: async (cmd: string) => {
      const gate = CONFIGURED.find((g) => cmd.includes(g.command));
      const fails = gate?.name === "test" && red-- > 0;
      return { exitCode: fails ? 1 : 0, stdout: "", stderr: fails ? "boom" : "" };
    },
  };
};

/** The step's line as timed() in src/burndown.ts builds it, then what it appends to timings.jsonl. */
const written = (result: Awaited<ReturnType<typeof runGates>>, elapsed: number, extra: Record<string, unknown> = {}) => {
  const line = { ts: "2026-01-01T00:00:00.000Z", run: "run-1", project: "fixture", issue: "7", phase: "gates", ...stepTimes(elapsed, result), ok: !result.failure, ...extra };
  return timingLines(line, result).map((l) => JSON.stringify(l) + "\n").join("");
};

test("a flake re-run inside the slot leaves the red run's line and then the green re-run's, as the ticket card reads them", async () => {
  const result = await runGates(project, flaky(), "fixture gates", false, {}, false, undefined, true);
  assert.equal(typeof result.rerunOf?.ms, "number", "the red run's time in the slot");
  const text = written(result, 60_000);
  assert.deepEqual(
    ticketPasses(text, "7", "run-1").map((p) => [p.phase, p.ok, p.red]),
    [
      ["gates", false, ["test"]],
      ["gates", true, undefined],
    ],
  );
  const [red, green] = text.trim().split("\n").map((l) => JSON.parse(l));
  // The step's time is split between the two lines and the wait, none of it lost or counted twice.
  assert.equal(red.ms + green.ms + (red.waitMs ?? 0), 60_000);
  // The re-run's line has only its own gates: lint passed once, in the red run.
  assert.deepEqual(Object.keys(red.gates ?? {}), ["lint", "test"]);
  assert.deepEqual(Object.keys(green.gates ?? {}), ["test"]);
});

test("the wait for the slot is on the red run's line, and the re-run's line has none", () => {
  const first = { gates: [{ name: "lint", pass: true, ms: 1000 }, { name: "test", pass: false, ms: 2000 }], failure: { name: "test", command: "run-tests", exitCode: 1, output: "boom" }, failures: [], waitMs: 5000, ms: 3000 };
  const result = { gates: [{ name: "lint", pass: true, ms: 1000 }, { name: "test", pass: true, ms: 1500 }], failures: [], waitMs: 5000, rerunOf: first };
  const [red, green] = written(result, 9500).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(red.waitMs, 5000);
  assert.equal(green.waitMs, undefined);
  assert.equal(red.ms, 3000);
  assert.equal(green.ms, 1500);
});

test("the memory pressure read while the gate went red reaches the closing summary", () => {
  const first = { gates: [{ name: "test", pass: false, ms: 2000 }], failure: { name: "test", command: "run-tests", exitCode: 1, output: "boom" }, failures: [], pressureSome: 40, pressureFull: 25, ms: 2000 };
  const result = { gates: [{ name: "test", pass: true, ms: 1000 }], failures: [], pressureSome: 2, rerunOf: first };
  const text = written(result, 3000, { pressureSome: 2 });
  assert.deepEqual(pressureFromTimings(text, "run-1"), { some: 40, full: 25, where: "ticket 7's gates" });
  const [red, green] = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(red.pressureSome, 40);
  assert.equal(green.pressureSome, 2);
  assert.equal(green.pressureFull, undefined);
});

test("a gate run with no re-run keeps its one line as it was", async () => {
  const result = await runGates(project, flaky(), "fixture gates", false, {});
  const line = { run: "run-1", issue: "7", phase: "gates", ms: 100, ok: false, red: ["test"] };
  assert.deepEqual(timingLines(line, result), [line]);
});

test("timed() in burndown() writes the step's lines through timingLines", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /appendFileSync\(timings, timingLines\(line, ended\)\.map\(\(l\) => JSON\.stringify\(l\) \+ "\\n"\)\.join\(""\)\);/);
  assert.match(src, /const result = await fn\(\);\n\s+ended = result;/);
});

test("a three-run result writes three lines in order, the wait on the first only and the ms summing to the step's", () => {
  const redFail = (output: string) => ({ name: "test", command: "run-tests", exitCode: 1, output });
  const one = { gates: [{ name: "lint", pass: true, ms: 1000 }, { name: "test", pass: false, ms: 2000 }], failure: redFail("FAILED tests/a.py::x"), failures: [], waitMs: 5000, ms: 3000, pressureSome: 40 };
  const two = { gates: [{ name: "test", pass: false, ms: 2500 }], failure: redFail("FAILED tests/b.py::y"), failures: [], ms: 2500, pressureSome: 30, rerunOf: one };
  const result = { gates: [{ name: "lint", pass: true, ms: 1000 }, { name: "test", pass: true, ms: 1500 }], failures: [], waitMs: 5000, pressureSome: 2, rerunOf: two };
  const text = written(result, 12_000, { pressureSome: 2 });
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.ok), [false, false, true]);
  assert.deepEqual(lines.map((l) => l.waitMs), [5000, undefined, undefined]);
  assert.deepEqual(lines.map((l) => l.ms), [3000, 2500, 1500]);
  // The wait is no part of the step's time, so the lines sum to the elapsed time less it.
  assert.equal(lines.reduce((sum, l) => sum + l.ms, 0) + 5000, 12_000);
  assert.deepEqual(lines.map((l) => Object.keys(l.gates ?? {})), [["lint", "test"], ["test"], ["test"]]);
  assert.deepEqual(lines.map((l) => l.pressureSome), [40, 30, 2]);
  assert.deepEqual(ticketPasses(text, "7", "run-1").map((p) => [p.phase, p.ok, p.red]), [["gates", false, ["test"]], ["gates", false, ["test"]], ["gates", true, undefined]]);
});

test("the re-run lines carry rerun: true and the first line does not", () => {
  const redFail = (output: string) => ({ name: "test", command: "run-tests", exitCode: 1, output });
  const one = { gates: [{ name: "test", pass: false, ms: 2000 }], failure: redFail("a"), failures: [], ms: 2000 };
  const two = { gates: [{ name: "test", pass: false, ms: 2000 }], failure: redFail("b"), failures: [], ms: 2000, rerunOf: one };
  const result = { gates: [{ name: "test", pass: true, ms: 1000 }], failures: [], rerunOf: two };
  const pair = written(two, 4000).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(pair.map((l) => l.rerun), [undefined, true]);
  const three = written(result, 5000).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(three.map((l) => l.rerun), [undefined, true, true]);
});
