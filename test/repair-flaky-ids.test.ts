// The tests a repair verdict records as `flaky` are ids of the red run the repair was given, not the agent's wording
// (`repairVerdict`, src/burndown.ts); the closing summary prints one `Likely flaky:` line per id and a red verify whose
// failing tests all flaked earlier in the run says so (src/report.ts); `verifyFailing` reads the uncut ids
// (src/gates.ts). Made-up facts and outputs; no Docker, model or network.
//
//   pnpm test:file test/repair-flaky-ids.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

const { repairVerdict } = await import("../src/burndown.ts");
const { verifyFailing } = await import("../src/gates.ts");
const { render } = await import("../src/report.ts");
type Facts = Parameters<typeof render>[0];

const said = (line?: string) => `Not this branch's.\n<verdict>outside-branch</verdict>\n${line === undefined ? "" : `Flaky: ${line}\n`}`;

test("a test title holding a semicolon is one test, not two", () => {
  const v = repairVerdict(said('test/a.test.ts "x (a; b)"'), ["test/a.test.ts::x (a; b)"]);
  assert.deepEqual(v?.tests, ["test/a.test.ts::x (a; b)"]);
  assert.equal(v?.line, 'test/a.test.ts "x (a; b)"');
});

test("an id whose test name is not in the line is dropped while another matches", () => {
  const v = repairVerdict(said("slow one"), ["test/a.test.ts::slow one", "test/a.test.ts::steady"]);
  assert.deepEqual(v?.tests, ["test/a.test.ts::slow one"]);
});

test("a line that names something matching no id gives every failing id", () => {
  const v = repairVerdict(said("the network test"), ["test/a.test.ts::alpha", "test/a.test.ts::beta"]);
  assert.deepEqual(v?.tests, ["test/a.test.ts::alpha", "test/a.test.ts::beta"]);
});

test("a file-only id is kept when the line names that path", () => {
  const v = repairVerdict(said("src/a.test.ts > adds"), ["src/a.test.ts", "src/b.test.ts"]);
  assert.deepEqual(v?.tests, ["src/a.test.ts"]);
});

test("no failing ids gives no tests, with the line kept", () => {
  assert.deepEqual(repairVerdict(said("lint is flaky"), []), { line: "lint is flaky", tests: [] });
  assert.deepEqual(repairVerdict(said("lint is flaky")), { line: "lint is flaky", tests: [] });
});

test("no Flaky line, and Flaky: none, give no tests", () => {
  assert.deepEqual(repairVerdict(said(), ["test/a.test.ts::one"]), { line: "", tests: [] });
  assert.deepEqual(repairVerdict(said("none"), ["test/a.test.ts::one"]), { line: "none", tests: [] });
  assert.deepEqual(repairVerdict(said("None - the base is red too"), ["test/a.test.ts::one"]), { line: "None - the base is red too", tests: [] });
  assert.equal(repairVerdict("<verdict>fixed</verdict>", ["test/a.test.ts::one"]), undefined);
});

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
const flakyLines = (out: string) => out.split("\n").filter((l) => l.startsWith("Likely flaky"));

test("two tickets' repairs that judged one id flaky in different words give one line naming both, a second id its own", () => {
  const ids = ["test/mod.test.ts::the mod's own tests pass", "test/pool.test.ts::takes a slot"];
  const one = repairVerdict(said("the mod's own tests pass"), ids.slice(0, 1))!;
  const two = repairVerdict(said("test/mod.test.ts - the mod's own tests pass (keep-warm)"), ids)!;
  const out = render(
    facts({
      tickets: {
        "1": { state: "red", title: "a", flaky: one.tests },
        "2": { state: "red", title: "b", flaky: two.tests.slice(0, 1) },
        "3": { state: "merged", title: "c", flaked: ["test/pool.test.ts::takes a slot"] },
      },
    }),
  );
  assert.deepEqual(flakyLines(out), ["Likely flaky: test/mod.test.ts::the mod's own tests pass (#1, #2)", "Likely flaky: test/pool.test.ts::takes a slot (#3)"]);
});

test("at most eight tests get a line, the rest one line of their count", () => {
  const flaked = Array.from({ length: 10 }, (_, i) => `test/t${i}.test.ts`);
  const out = render(facts({ tickets: { "1": { state: "merged", title: "a", flaked } } }));
  assert.equal(flakyLines(out).length, 9);
  assert.equal(flakyLines(out).at(-1), "Likely flaky: and 2 more");
});

const CLAUSE = "a test this run already saw flake";
const verifyLine = (verify: Record<string, unknown>, tickets: Facts["tickets"]) =>
  render(facts({ verify: { green: false, line: "test red", ...verify } as Facts["verify"], tickets })).split("\n").find((l) => l.startsWith("Merged main re-gated"))!;
const flakedOnOne: Facts["tickets"] = { "1": { state: "merged", title: "a", flaked: ["test/a.test.ts::x", "test/b.test.ts::y"] } };

test("a red verify whose failing ids all flaked earlier in the run says so", () => {
  assert.match(verifyLine({ failing: ["test/a.test.ts::x"] }, flakedOnOne), new RegExp(CLAUSE));
  assert.match(verifyLine({ failing: ["test/a.test.ts::x", "test/b.test.ts::y"] }, flakedOnOne), new RegExp(CLAUSE));
});

test("a failing id outside the flaked ones, a cut list, no ids, or a flake only in a carried turn earn no clause", () => {
  assert.doesNotMatch(verifyLine({ failing: ["test/a.test.ts::x", "test/c.test.ts::z"] }, flakedOnOne), new RegExp(CLAUSE));
  assert.doesNotMatch(verifyLine({ failing: ["test/a.test.ts::x"], failingMore: true }, flakedOnOne), new RegExp(CLAUSE));
  assert.doesNotMatch(verifyLine({ failing: [] }, flakedOnOne), new RegExp(CLAUSE));
  assert.doesNotMatch(verifyLine({}, flakedOnOne), new RegExp(CLAUSE));
  const carried = { turn: 1, facts: facts({ tickets: flakedOnOne }) };
  const line = render(facts({ verify: { green: false, line: "test red", failing: ["test/a.test.ts::x"] }, carried: [carried] })).split("\n").find((l) => l.startsWith("Merged main re-gated"))!;
  assert.doesNotMatch(line, new RegExp(CLAUSE));
});

test("verifyFailing returns an id its clipped output no longer shows", () => {
  const failure = { name: "test", command: "t", exitCode: 1, output: "… output cut …\nnothing readable", tests: ["test/a.test.ts::gone"] };
  assert.deepEqual(verifyFailing([failure]), { tests: ["test/a.test.ts::gone"], more: false });
});
