// The estimate printed at a turn's start is kept on that turn's run record as figures, and the record appended to
// history.jsonl keeps them, so a later change to the estimate can be judged against what the turn took. Made-up
// timings history and project; no Docker, model or network.
//
//   pnpm test:file test/estimate-record.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { estimate, priceRun, recordRun } = await import("../src/run.ts");
type Project = Parameters<typeof recordRun>[0];

const MIN = 60_000;

/** Five tickets of 10 to 50 minutes, each with k x 100k tokens in and k x 1k out: the median is the third, the 80th percentile the fourth. */
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-record-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = [1, 2, 3, 4, 5].map((k) =>
    JSON.stringify({ project: "fixture", run: "r1", issue: String(k), phase: "implement", ms: k * 10 * MIN, tokens: { input: 0, cacheWrite: 0, cacheRead: k * 100_000, output: k * 1_000 } }),
  );
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

const logs = (p: Project, file: string) => join(p.root, ".sandcastle/logs", file);

test("the run record written at the start carries the figures of the estimate line, and the history line keeps them", () => {
  const p = project();
  // 2 tickets on 2 slots: the median ticket is 30m, 300k in, 3k out; the 80th percentile 40m, 400k in, 4k out.
  const priced = priceRun(p, 2, 2);
  assert.ok(priced);
  assert.equal(priced.text, estimate(p, 2, 2));
  const expected = {
    ms: { mid: 30 * MIN, high: 40 * MIN },
    tokensIn: { mid: 600_000, high: 800_000 },
    tokensOut: { mid: 6_000, high: 8_000 },
    slots: 2,
    tickets: 2,
  };
  assert.deepEqual(priced.figures, expected);

  const run = recordRun(p, { issues: ["6", "7"], estimate: priced.figures });
  assert.deepEqual(JSON.parse(readFileSync(logs(p, "run.json"), "utf8")).estimate, expected);
  run.finishWith(() => ({}));
  // A new record finishes the one before it, as the next turn's would.
  recordRun(p).finishWith(() => ({}));
  const history = readFileSync(logs(p, "history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(history[0].estimate, expected);
});

test("a project with no timings history prices nothing, so a record built from it has no estimate field", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-estimate-record-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const p = { root, name: "fixture" } as Project;
  assert.equal(priceRun(p, 2, 2), undefined);
  const priced = priceRun(p, 2, 2);
  recordRun(p, { issues: ["1"], ...(priced ? { estimate: priced.figures } : {}) }).finishWith(() => ({}));
  recordRun(p).finishWith(() => ({}));
  const first = JSON.parse(readFileSync(logs(p, "history.jsonl"), "utf8").split("\n").filter(Boolean)[0]);
  assert.equal("estimate" in first, false);
});

test("burndown() prints the estimate's line and puts its figures on the run record it writes next", () => {
  const src = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(src, /const rough = priceRun\(/);
  assert.match(src, /if \(rough\) console\.log\(rough\.text\);/);
  assert.match(src, /\.\.\.\(rough \? \{ estimate: rough\.figures \} : \{\}\),/);
});
