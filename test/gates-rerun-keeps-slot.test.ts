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

test("a file the red run's gates rewrote is still reported after the re-run, which starts past the gate that rewrote it", async () => {
  // lint rewrites a tracked file and passes, test goes red, and the re-run starts at test: lint never runs again.
  let dirty = false;
  let red = 1;
  const box = {
    exec: async (cmd: string) => {
      if (cmd.startsWith("git status")) return { exitCode: 0, stdout: dirty ? " M src/fmt.ts\0" : "", stderr: "" };
      if (cmd.startsWith("git checkout HEAD --")) {
        dirty = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("run-lint")) {
        dirty = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("run-tests")) return { exitCode: red-- > 0 ? 1 : 0, stdout: "", stderr: "boom" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const result = await runGates(project, box, "fixture gates", false, {}, false, undefined, true);
  assert.equal(result.failure, undefined);
  assert.ok(result.rerunOf);
  assert.deepEqual(result.rewrote, ["src/fmt.ts"]);
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

/**
 * A fake sandbox whose `test` gate (`run-tests`) answers each run with the next of `outputs`: a string is a red run
 * printing it, `null` a green one, `{ timeout }` a gate stopped at its limit. Each run of the gate rewrites its own
 * tracked file (`f1.ts`, `f2.ts`, ...), which the gates put back. Another run waits for the pool from a minute ago.
 */
const scripted = (outputs: (string | null | { timeout: true })[], lintRedOnRun?: number) => {
  const ran: string[] = [];
  const seen: { gate: string; locks: number; waits: number }[] = [];
  let tests = 0;
  let lints = 0;
  let dirty: string | undefined;
  let rival = false;
  return {
    ran,
    seen,
    exec: async (cmd: string) => {
      if (cmd.startsWith("git status")) return { exitCode: 0, stdout: dirty ? ` M ${dirty}\0` : "", stderr: "" };
      if (cmd.startsWith("git checkout HEAD --")) {
        dirty = undefined;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
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
      if (gate.name === "lint") return { exitCode: ++lints === lintRedOnRun ? 1 : 0, stdout: "", stderr: lints === lintRedOnRun ? "lint boom" : "" };
      const out = outputs[tests++] ?? null;
      dirty = `f${tests}.ts`;
      if (out === null) return { exitCode: 0, stdout: "", stderr: "" };
      if (typeof out === "object") return { exitCode: 124, stdout: "", stderr: "" };
      return { exitCode: 1, stdout: out, stderr: "" };
    },
  };
};

test("a re-run red on other tests than the first red gets a third pass in the same slot, with no second wait", async () => {
  const box = scripted(["FAILED tests/a.py::x - boom", "FAILED tests/b.py::y - boom", null]);
  const again: string[] = [];
  const result = await runGates(project, box, "fixture gates", false, { again: (name) => void again.push(name) }, false, undefined, true, true);
  assert.deepEqual(box.ran, ["lint", "test", "test", "test"]);
  assert.deepEqual(again, ["test", "test"]);
  // One lease for all three passes, and no wait of this run's behind the rival's older one.
  assert.deepEqual(box.seen.map((s) => [s.gate, s.locks, s.waits]), [["lint", 1, 0], ["test", 1, 0], ["test", 1, 0], ["test", 1, 0]]);
  assert.deepEqual(mineInGates(), { locks: 0, waits: 0 });
  // The result is the third run's; the chain runs back through the re-run to the first red.
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", true]]);
  const second = result.rerunOf;
  const first = second?.rerunOf;
  assert.match(second?.failure?.output ?? "", /tests\/b\.py::y/);
  assert.equal(typeof second?.ms, "number");
  assert.match(first?.failure?.output ?? "", /tests\/a\.py::x/);
  assert.equal(typeof first?.ms, "number");
  assert.equal(first?.rerunOf, undefined);
  assert.deepEqual(first?.gates.map((g) => [g.name, g.pass]), [["lint", true], ["test", false]]);
  // The wait is the first run's alone.
  assert.equal(result.waitMs, first?.waitMs);
  assert.equal(second?.waitMs, undefined);
  // The files all three runs' gates rewrote.
  assert.deepEqual([...(result.rewrote ?? [])].sort(), ["f1.ts", "f2.ts", "f3.ts"]);
});

test("a ticket gate asked for a re-run alone, as a landing does, makes two passes on the same reds", async () => {
  const box = scripted(["FAILED tests/a.py::x - boom", "FAILED tests/b.py::y - boom", null]);
  const result = await runGates(project, box, "fixture gates", false, {}, false, undefined, true);
  assert.deepEqual(box.ran, ["lint", "test", "test"]);
  assert.equal(result.failure?.name, "test");
  assert.equal(result.rerunOf?.rerunOf, undefined);
});

test("a re-run red on a later gate makes no third pass", async () => {
  // The re-run of `lint` passes it and goes red on `test`, which never ran before: a first red there, not a flake.
  const box = scripted(["FAILED tests/b.py::y - boom"], 1);
  const result = await runGates(project, box, "fixture gates", false, {}, false, undefined, true, true);
  assert.deepEqual(box.ran, ["lint", "lint", "test"]);
  assert.equal(result.failure?.name, "test");
  assert.equal(result.rerunOf?.rerunOf, undefined);
});

test("a re-run that timed out makes no third pass", async () => {
  const box = scripted(["FAILED tests/a.py::x - boom", { timeout: true }, null]);
  const result = await runGates(project, box, "fixture gates", false, {}, false, undefined, true, true);
  assert.deepEqual(box.ran, ["lint", "test", "test"]);
  assert.equal(result.failure?.exitCode, 124);
  assert.equal(result.rerunOf?.rerunOf, undefined);
});

test("a re-run red on some of the same tests makes no third pass", async () => {
  const box = scripted(["FAILED tests/a.py::x - boom", "FAILED tests/a.py::x - boom\nFAILED tests/b.py::y - boom", null]);
  const result = await runGates(project, box, "fixture gates", false, {}, false, undefined, true, true);
  assert.deepEqual(box.ran, ["lint", "test", "test"]);
  assert.equal(result.rerunOf?.rerunOf, undefined);
});

test("a third run that is red too returns its failure with all three runs chained", async () => {
  const box = scripted(["FAILED tests/a.py::x - boom", "FAILED tests/b.py::y - boom", "FAILED tests/c.py::z - boom"]);
  const result = await runGates(project, box, "fixture gates", false, {}, false, undefined, true, true);
  assert.deepEqual(box.ran, ["lint", "test", "test", "test"]);
  assert.match(result.failure?.output ?? "", /tests\/c\.py::z/);
  assert.match(result.rerunOf?.failure?.output ?? "", /tests\/b\.py::y/);
  assert.match(result.rerunOf?.rerunOf?.failure?.output ?? "", /tests\/a\.py::x/);
});
