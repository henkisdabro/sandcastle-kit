// Each finished run appends its final run.json, as one line, to
// .sandcastle/logs/history.jsonl - run.json itself is overwritten by the next run.
//
//   node --test test/history.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runKit } from "./cli-spawn.ts";

const KIT = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "sandcastle-history-"));
const cache = mkdtempSync(join(tmpdir(), "sandcastle-history-cache-"));
const script = join(root, "record.mts");
writeFileSync(
  script,
  `import { recordRun } from ${JSON.stringify(pathToFileURL(join(KIT, "src/run.ts")).href)};
const r = recordRun({ root: ${JSON.stringify(root)}, name: "fixture" } as any, { dryRun: true });
r.ticket("7", { state: "merged" });
`,
);

const runOnce = () => {
  const res = runKit([], {
    script,
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: cache },
  });
  assert.equal(res.status, 0, res.stderr);
};
const history = () => readFileSync(join(root, ".sandcastle/logs/history.jsonl"), "utf8");

test("a finished run appends its run.json as one line, and the next run adds another", () => {
  runOnce();
  const first = history();
  const lines = first.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(entry, JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8")));
  assert.ok(entry.finishedAt);
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.tickets["7"].state, "merged");
  assert.equal(entry.dryRun, true);

  runOnce();
  const second = history();
  assert.equal(second.split("\n").filter(Boolean).length, 2);
  assert.ok(second.startsWith(first), "the first line is unchanged byte for byte");
});
