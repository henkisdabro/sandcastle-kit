// A ticket gate's one re-run of its red gate runs inside the gates slot of the run that went red. Each gate run
// used to lease its own slot, so the re-run queued again behind every other run's wait - minutes, for a re-run
// meant to find out whether the machine was only busy. Here the pool is real (test/pool-sim.ts, one gates slot)
// and another run's wait for it is older than any this run makes, so a second lease would never be granted:
// the re-run finishing at all shows it took none. No Docker, model or network.
//
//   pnpm test:file test/gates-rerun-keeps-slot.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, other, RUN_ID, slots } from "./pool-sim.ts";

const { runGates } = await import("../src/gates.ts");

afterEach(cleanup);

const CONFIGURED = [
  { name: "lint", command: "run-lint" },
  { name: "test", command: "run-tests" },
];
const project = { name: "fixture", gates: CONFIGURED } as Parameters<typeof runGates>[0];

const waitsDir = join(slots, "waits");
/** This run's entries in the gates pool: its leases (lock files) and its waits. */
const mineInGates = () => {
  const locks = readdirSync(slots).filter((f) => f.startsWith("gates-") && f.endsWith(".lock") && readFileSync(join(slots, f), "utf8").includes(` run=${RUN_ID} `));
  const waits = readdirSync(waitsDir).filter((f) => f.startsWith("gates-") && f.includes(`-${RUN_ID}-`));
  return { locks: locks.length, waits: waits.length };
};

/**
 * A fake sandbox whose gates are red on `redOn` for its first `redTimes` runs. When the first gate of the first
 * run starts, another run begins waiting for the gates pool, from a minute ago: older than anything this run asks.
 */
const sandbox = (redOn: string, redTimes: number) => {
  const ran: string[] = [];
  const seen: { gate: string; locks: number; waits: number }[] = [];
  let red = redTimes;
  let rival = false;
  return {
    ran,
    seen,
    exec: async (cmd: string) => {
      const gate = CONFIGURED.find((g) => cmd.includes(g.command));
      if (!gate) return { exitCode: 0, stdout: "", stderr: "" };
      if (!rival) {
        rival = true;
        other("rival", { demand: 1 });
        mkdirSync(waitsDir, { recursive: true });
        const since = Date.now() - 60_000;
        writeFileSync(join(waitsDir, `gates-${since}-rival-0.wait`), `${process.pid} rival ${since} another run's gates\n`);
      }
      ran.push(gate.name);
      seen.push({ gate: gate.name, ...mineInGates() });
      const fails = gate.name === redOn && red > 0;
      if (fails) red--;
      return { exitCode: fails ? 1 : 0, stdout: "", stderr: fails ? "boom" : "" };
    },
  };
};

const logOf = () => join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "gates.log");

test("a red ticket gate's re-run takes no second gates slot and waits for none while another run waits longer", async () => {
  const box = sandbox("test", 1);
  const log = logOf();
  const again: string[] = [];
  const result = await runGates(project, box, "fixture gates", false, { log, again: (name) => void again.push(name) }, false, undefined, true);
  // lint, the red test, then the re-run from test alone.
  assert.deepEqual(box.ran, ["lint", "test", "test"]);
  assert.deepEqual(again, ["test"]);
  // One lease, held for both runs of the red gate, and no wait of this run's in the gates pool at either.
  assert.deepEqual(box.seen.map((s) => [s.gate, s.locks, s.waits]), [["lint", 1, 0], ["test", 1, 0], ["test", 1, 0]]);
  // The slot is back once the call returns.
  assert.deepEqual(mineInGates(), { locks: 0, waits: 0 });
  // The re-run was green: the result is the re-run's, its gates the passes before the red one then the re-run's.
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", true]]);
  assert.equal(result.rerunOf?.failure?.name, "test");
  assert.deepEqual(result.rerunOf?.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", false]]);
  // The first run's wait is the call's, and the re-run adds none.
  assert.equal(result.waitMs, result.rerunOf?.waitMs);
  assert.ok((result.waitMs ?? 0) < 1000, "the first run found the pool free");
  const text = readFileSync(log, "utf8");
  assert.match(text, /# gate 1\/2: lint, /);
  assert.equal(text.match(/# gate 2\/2: test, /g)?.length, 2);
  assert.doesNotMatch(text, /# waited/);
});

test("a re-run that is red again returns its failure, still inside the one slot", async () => {
  const box = sandbox("lint", 2);
  const result = await runGates(project, box, "fixture gates", false, {}, false, undefined, true);
  assert.deepEqual(box.ran, ["lint", "lint"]);
  assert.equal(result.failure?.name, "lint");
  assert.deepEqual(result.gates.map((g) => [g.name, g.pass]), [["lint", false]]);
  assert.ok(result.rerunOf);
  assert.deepEqual(mineInGates(), { locks: 0, waits: 0 });
});

test("a green run makes no second pass", async () => {
  const box = sandbox("none", 0);
  const result = await runGates(project, box, "fixture gates", false, {}, false, undefined, true);
  assert.deepEqual(box.ran, ["lint", "test"]);
  assert.equal(result.rerunOf, undefined);
});

test("a red run that was not asked to re-run makes no second pass", async () => {
  const box = sandbox("test", 1);
  const result = await runGates(project, box, "fixture gates", false, {});
  assert.deepEqual(box.ran, ["lint", "test"]);
  assert.equal(result.failure?.name, "test");
  assert.equal(result.rerunOf, undefined);
});
