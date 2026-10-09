// The start estimate and the split line count the slot kept for landing (src/pool.ts `keptForLanding`):
// beside another live run, a share of 2 or more gives the tickets share - 1 slots. `estimateSlots` and
// `startLines` are pure; `burndown()` needs Docker, so a source match holds that it passes `!DRY_RUN`
// (a dry run keeps nothing). No Docker, model or network.
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

test("the estimate's slots are the share less the one kept for landing, from a share of 2", () => {
  assert.equal(estimateSlots(5, at(3)), 2);
  assert.equal(estimateSlots(5, at(2)), 1);
  assert.equal(estimateSlots(5, at(3), false), 3, "a dry run keeps nothing");
  assert.equal(estimateSlots(5, at(1)), 1, "a share of 1 is a ticket's");
  assert.equal(estimateSlots(5, undefined), 5, "a run alone keeps the machine's figure");
});

test("the start line says the tickets' share and the slot kept for landing", () => {
  const [line] = startLines({ share: 2, free: 0 }, [neighbour]);
  assert.match(line, /this run's share is 2, its tickets 1 at a time \(one slot is kept for landing\); it starts as webshop's tickets finish/);
  assert.match(startLines({ share: 3, free: 0 }, [neighbour])[0], /share is 3, its tickets 2 at a time \(one slot/);
});

test("the start line is as before at a share of 1 and in a dry run", () => {
  assert.match(startLines({ share: 1, free: 0 }, [neighbour])[0], /this run's share is 1; it starts as/);
  assert.match(startLines({ share: 2, free: 0 }, [neighbour], false)[0], /this run's share is 2; it starts as/);
});

test("the estimate beside another run counts the tickets' slots, not the whole share", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-kept-"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  const tok = { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 10_000 };
  const lines = [
    { issue: "1", phase: "implement", ms: 600_000, tokens: tok },
    { issue: "1", phase: "gates", ms: 600_000 },
  ];
  writeFileSync(join(root, ".sandcastle/logs/timings.jsonl"), lines.map((l) => JSON.stringify({ project: "fixture", run: "r1", ...l })).join("\n") + "\n");
  // Six wanted, a share of 3 beside the other run: two tickets at a time.
  const line = estimate({ root, name: "fixture" } as Parameters<typeof estimate>[0], 6, estimateSlots(6, splitAtStart(6, [member])));
  assert.match(line!, /for 6 ticket\(s\), 2 at a time/);
  rmSync(root, { recursive: true, force: true });
});

test("burndown() hands the estimate and the start line whether it is a dry run", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/burndown.ts"), "utf8");
  assert.match(src, /estimateSlots\(workers, split, !DRY_RUN\)/);
  assert.match(src, /\}\), !DRY_RUN, project\.name\)\) console\.log\(line\)/);
});
