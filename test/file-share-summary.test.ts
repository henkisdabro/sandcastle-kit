// The start-of-run plan names the mergeable files tickets share one line per file, not one per pair
// (`createHoldRecord` in src/burndown.ts, `fileShareSummary` in src/schedule.ts): a wide run printed
// dozens of pair lines and buried the pool warning. The docs files every ticket touches are one count,
// and the full pair list goes to the hold record's `log`. Fake files; no git, no Docker, no network.
//
//   node --test test/file-share-summary.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing burndown.ts must not touch the real config or cache.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { createHoldRecord } = await import("../src/burndown.ts");
const { createSchedule } = await import("../src/schedule.ts");

type T = { id: string };
const ref = (id: string) => `#${id}`;
const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));

const start = (files: (id: string) => string[]) => {
  const said: string[] = [];
  const logged: string[] = [];
  const { start } = createSchedule<T, { issue: string }>({ tickets: ids.map((id) => ({ id })), files: { of: (t) => ({ all: files(t.id), unmergeable: [] }) } });
  createHoldRecord({ waiting: [], ref, say: (line) => void said.push(line.trim()), log: (line) => void logged.push(line) }).start(start);
  return { said, logged };
};

test("twelve tickets sharing two files print one line per file", () => {
  const { said } = start(() => ["src/a.ts", "src/b.ts"]);
  const all = ids.map(ref).join(" ");
  assert.deepEqual(said, ["tickets that share files; if they conflict at landing, the later one is sent back once and its merge resolved:", `src/a.ts: ${all}`, `src/b.ts: ${all}`]);
});

test("the docs files every ticket touches are one count, and the pair list goes to the log", () => {
  const { said, logged } = start((id) => ["README.md", "CHANGELOG.md", ...(Number(id) <= 3 ? ["src/x.ts"] : [])]);
  assert.deepEqual(said.slice(1), ["src/x.ts: #1 #2 #3", "CHANGELOG.md, README.md: shared by 12 tickets (not listed)"]);
  // 12 tickets: every ticket after the first shares with each earlier one, 66 pairs.
  assert.equal(logged.length, 66);
  assert.ok(logged.includes("#1 and #2 both change CHANGELOG.md, README.md, src/x.ts - if they conflict at landing, the later one is sent back once and its merge resolved"), logged[0]);
});

test("tickets that share nothing print nothing", () => {
  const { said, logged } = start((id) => [`file-${id}.ts`]);
  assert.deepEqual([said, logged], [[], []]);
});
