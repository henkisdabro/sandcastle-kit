// The run record's live pool values (GLOSSARY.md: run record): `demand` (the sandbox slots the
// run could use now) and `share` (its part of the machine pool) sit beside the run's own fields,
// never inside the `settings` group, which holds what a turn was told at its start. The record
// writes them as they change, and the status view reads each by that name. No Docker, no network.
//
//   pnpm test:file test/run-record-pool.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildFixture } from "./status-fixture.ts";
import { drawFrame, readFacts } from "./status-run.ts";

const root = mkdtempSync(join(tmpdir(), "sandcastle-record-pool-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-record-pool-cache-"));
const { recordRun } = await import("../src/run.ts");

const kit = join(import.meta.dirname, "..");
const written = () => JSON.parse(readFileSync(join(root, ".sandcastle/logs/run.json"), "utf8"));

test("a written run record carries demand and share, apart from the run settings", () => {
  const run = recordRun({ root, name: "fixture" } as never, { concurrency: 4, settings: { autonomy: 2, turn: 1, cap: 2 } });
  assert.equal(written().demand, undefined, "none until the run says so");
  run.update({ demand: 4, share: 3 });
  assert.equal(written().demand, 4);
  assert.equal(written().share, 3);
  run.update({ share: 2 });
  assert.deepEqual([written().demand, written().share], [4, 2], "each is rewritten alone, the other kept");
  assert.deepEqual(written().settings, { autonomy: 2, turn: 1, cap: 2 }, "the settings group is untouched");
  assert.equal(run.finished, false);
});

test("the record type declares both values outside the settings group", () => {
  const record = readFileSync(join(kit, "mod/hooks/run-record.ts"), "utf8");
  const fields = (name: string) => [...(record.match(new RegExp(`export type ${name} = \\{\\n([\\s\\S]*?)\\n\\};`))?.[1] ?? "").matchAll(/^  (\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields("RunRecord").includes("demand") && fields("RunRecord").includes("share"));
  assert.ok(!fields("RunSettings").includes("demand") && !fields("RunSettings").includes("share"));
});

test("the status view shows the record's demand and share by those names", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-record-pool-view-"));
  const fixture = buildFixture("live", dir);
  try {
    const file = join(fixture.root, ".sandcastle/logs/run.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), demand: 5, share: 2 }));
    const drawn = drawFrame(fixture, { cols: 200 });
    assert.equal(drawn.status, 0, drawn.stderr);
    assert.equal(readFacts(drawn.raw, fixture.root).run["this run"], "wants 5 · share 2");
  } finally {
    fixture.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
