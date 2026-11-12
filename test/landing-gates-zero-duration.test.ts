// A landing gates line proves gates ran even when their recorded duration is 0 ms.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { typicalTimes } = await import("../src/run.ts");
type Project = Parameters<typeof typicalTimes>[0];

const project = (durations: (number | undefined)[]) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-landing-zero-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const lines = durations.flatMap((ms, i) => [
    { phase: "gates", ms: 60_000 },
    ...(ms === undefined ? [] : [{ phase: "landing gates", ms }]),
    { phase: "landing", ms: ms ?? 1, ok: true },
  ].map((line) => JSON.stringify({ project: "fixture", run: "r1", issue: String(i + 1), ...line })));
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.join("\n") + "\n");
  return { root, name: "fixture" } as Project;
};

test("recorded zero-duration landing gates participate in the median beside slower passes", () => {
  assert.equal(typicalTimes(project([0, 0, 300_000, undefined]))["landing gates"], 0);
});

test("recorded zero-duration landing gates prevent the fallback to ticket gates", () => {
  assert.equal(typicalTimes(project([0, undefined]), [], 2)["landing gates"], 0);
});
