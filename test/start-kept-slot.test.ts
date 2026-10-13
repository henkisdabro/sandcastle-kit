// The start estimate and the split line count the one slot the pool keeps for landing (src/pool.ts `shareable`,
// `lastFreeSlot`): beside another live run the shares split the pool less that slot, so the whole share is the
// tickets'. `estimateSlots`, `splitAtStart` and `startLines` are pure; `burndown()` needs Docker, so a source match
// holds what it passes. No Docker, model or network.
//
//   pnpm test:file test/start-kept-slot.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.SANDCASTLE_MAX_SANDBOXES = "6";
const { estimateSlots, splitAtStart, startLines } = await import("../src/pool.ts");
const { estimate } = await import("../src/run.ts");
type Member = Parameters<typeof splitAtStart>[1][number];
type Neighbour = Parameters<typeof startLines>[1][number];

const member: Member = { run: "other", project: "webshop", pid: 1, demand: 5, held: 6, share: 3, registered: true, since: 1 };
const at = (share: number) => ({ share, free: 0 });
const neighbour: Neighbour = { project: "webshop", registered: true, held: 2, demand: 2 };

test("the estimate's slots are the whole share beside another run: the landing slot is outside it", () => {
  assert.equal(estimateSlots(5, at(3)), 3);
  assert.equal(estimateSlots(5, at(2)), 2);
  assert.equal(estimateSlots(5, at(1)), 1);
  assert.equal(estimateSlots(2, at(3)), 2, "never more than the run's workers");
  assert.equal(estimateSlots(5, undefined), 5, "a run alone keeps the machine's figure");
});

test("the pool is split less one slot beside another run, and whole when the run is alone", () => {
  // 6 slots, a run of demand 5 beside one of demand 5 (the other registered first): 3 + 2.
  assert.equal(splitAtStart(5, [member]).share, 2);
  assert.equal(splitAtStart(5, [{ ...member, since: 1_000_000_000_000_000 }]).share, 3);
  // 3 slots between two runs of demand 5: 1 + 1 and one slot for landing.
  assert.equal(splitAtStart(5, [{ ...member, held: 1 }], 3).share, 1);
  assert.deepEqual(splitAtStart(5, [{ ...member, held: 1 }], 3), { share: 1, free: 1 });
  assert.deepEqual(splitAtStart(5, []), { share: 5, free: 6 });
  assert.equal(splitAtStart(5, [{ ...member, demand: 0, held: 0 }]).share, 5, "a run that wants and holds nothing keeps no slot back");
  assert.equal(splitAtStart(5, [{ ...member, held: 0, since: 1_000_000_000_000_000 }], 1).share, 1, "a pool of one slot keeps none: no ticket would ever run");
});

test("the start line says the share and that one of the pool's slots is kept for any run's landing", () => {
  const [line] = startLines({ share: 2, free: 0 }, [neighbour]);
  assert.match(line, /this run's share is 2 \(one of the pool's slots is kept for any run's landing\); it starts as webshop's tickets finish/);
  assert.match(startLines({ share: 1, free: 0 }, [neighbour])[0], /this run's share is 1 \(one of the pool's slots is kept for any run's landing\); it starts as/);
});

test("the start line of a dry run, which lands nothing, says nothing of a landing slot", () => {
  assert.match(startLines({ share: 2, free: 0 }, [neighbour], false)[0], /this run's share is 2; it starts as/);
});

test("the estimate beside another run divides by the run's share", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-kept-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const tok = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };
  const lines = [
    { issue: "1", phase: "implement", ms: 600_000, tokens: tok },
    { issue: "1", phase: "gates", ms: 600_000 },
  ];
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.map((l) => JSON.stringify({ project: "fixture", run: "r1", ...l })).join("\n") + "\n");
  // Six wanted, a share of 2 beside the other run (5 slots split 3 + 2): two tickets at a time.
  const line = estimate({ root, name: "fixture" } as Parameters<typeof estimate>[0], 6, estimateSlots(6, splitAtStart(6, [member])));
  assert.match(line!, /for 6 ticket\(s\), 2 at a time/);
  rmSync(root, { recursive: true, force: true });
});

test("burndown() hands the start line whether it is a dry run, and the estimate the split", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /estimateSlots\(workers, split\)/);
  assert.match(src, /, neighbours, !DRY_RUN, project\.name, project\.root\)\) console\.log\(line\)/);
});
