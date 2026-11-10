// Each sandbox container gets a memory limit: on a Docker Desktop or OrbStack VM every sandbox shares one ceiling, and one
// suite that balloons pushed the others into the VM's OOM killer. The limit is the project's `memory`, else 1.5 x its
// measured anonymous memory once it has 10 samples, else none; it is set after the open with `docker update`, and a gate
// or agent pass the kernel killed at it says so rather than a bare exit 137. A fake `docker` on PATH logs each call; the
// sandbox is a fake `exec` whose kernel files answer from variables the test sets. No Docker, model or network.
//
//   pnpm test:file test/sandbox-memory.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

// Before the kit's modules load: they read these once, for their directories.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { loadProject, memoryBytes } = await import("../src/config.ts");
const { OperatorError } = await import("../src/errors.ts");
const { limitMemory, oomKills, oomNote, withOom } = await import("../src/sandbox.ts");
const { agentFailure } = await import("../src/agents.ts");
const { MIN_SAMPLES, memoryLimit, memoryLine, sandboxMemory } = await import("../src/size.ts");
const { exitWords, runGates } = await import("../src/gates.ts");
const { onNoPsi, projectId, sampling } = await import("../src/peaks.ts");
type Line = Parameters<typeof memoryLimit>[1][number];

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-memory-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const MIB = 2 ** 20;
const GIB = 2 ** 30;
const NOW = Date.parse("2026-05-10T00:00:00Z");

const calls = join(tmp, "calls");
// FAKE_SWAP_FAIL: a kernel with no swap accounting, which refuses `--memory-swap` alone.
writeFileSync(join(tmp, "docker"), `#!/bin/sh\necho "docker $*" >> '${calls}'\n[ -n "$FAKE_DOCKER_FAIL" ] && echo "no such container" >&2 && exit 1\ncase "$*" in *--memory-swap*) [ -n "$FAKE_SWAP_FAIL" ] && echo "Your kernel does not support swap limit capabilities" >&2 && exit 1;; esac\nexit 0\n`);
chmodSync(join(tmp, "docker"), 0o755);
process.env.PATH = [tmp, process.env.PATH ?? ""].join(delimiter);
const seen = () => {
  try {
    return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

let n = 0;
const load = (extra: string) => {
  const root = join(tmp, `p${n++}`);
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "t", tracker: "files", gates: [{ name: "t", command: "true" }]${extra} };\n`);
  return loadProject(root);
};

// ---- the setting ----

test("memory takes bytes or docker's own sizes, and normalises them to bytes", async () => {
  assert.equal(memoryBytes("6g"), 6 * GIB);
  assert.equal(memoryBytes("6GB"), 6 * GIB);
  assert.equal(memoryBytes("6gib"), 6 * GIB);
  assert.equal(memoryBytes("512m"), 512 * MIB);
  assert.equal(memoryBytes("1.5g"), 1.5 * GIB);
  assert.equal(memoryBytes(4 * GIB), 4 * GIB);
  for (const bad of ["6x", "", "g", "1m", 1000, 1.5, -1, null, true]) assert.equal(memoryBytes(bad), undefined, String(bad));
  assert.equal((await load(`, memory: "6g"`)).memory, 6 * GIB);
  assert.equal((await load(`, memory: false`)).memory, false);
  assert.equal((await load("")).memory, undefined);
});

test("a memory that is neither a size nor false is refused at load", async () => {
  for (const bad of ['"lots"', "0", "true", '"1m"']) {
    await assert.rejects(load(`, memory: ${bad}`), (e: Error) => e instanceof OperatorError && /`memory` must be bytes or a size such as "6g"/.test(e.message), bad);
  }
});

// ---- the default ----

// `n` sandboxes of one run, each a gate's anonymous figure `anon` and an agent's `agent`, marked as read during a phase.
const sandboxes = (count: number, anon: number, agent?: number, project = "p1"): Line[] =>
  Array.from({ length: count }, () => ({ ts: "2026-05-09T00:00:00.000Z", project, run: "r1", peakMib: anon + 1000, anonMib: anon, sampled: 2, ...(agent ? { agentAnonMib: agent } : {}) }));

test("unset, the limit is 1.5 x the higher anonymous figure, rounded up to 256 MiB, and the start line says where it came from", () => {
  // 3500 x 1.5 = 5250 MiB, up to 5376 (21 x 256).
  const limit = memoryLimit(undefined, sandboxes(10, 3000, 3500), "p1", NOW);
  assert.deepEqual(limit, { bytes: 5376 * MIB, from: "measured", anonMib: 3500 });
  assert.equal(memoryLine(limit), "Sandbox memory: 5.3 GiB each (1.5 x the 3.42 GiB of anonymous memory measured; memory in the project config sets it)");
  // An agent figure with too few samples does not count: the gate's 3000 x 1.5 = 4500, up to 4608.
  const fewAgents = [...sandboxes(10, 3000), ...sandboxes(3, 3000, 9000)];
  assert.equal(memoryLimit(undefined, fewAgents, "p1", NOW).bytes, 4608 * MIB);
  // Never under the floor, and never above the VM.
  assert.equal(memoryLimit(undefined, sandboxes(10, 300), "p1", NOW).bytes, 2 * GIB);
  assert.deepEqual(memoryLimit(undefined, sandboxes(10, 3000, 3500), "p1", NOW, 4 * GIB), { bytes: 4 * GIB, capped: true, from: "measured", anonMib: 3500 });
});

test("unset, under ten gate samples there is no limit, and the start line counts them", () => {
  const limit = memoryLimit(undefined, sandboxes(MIN_SAMPLES - 1, 3000), "p1", NOW);
  assert.deepEqual(limit, { from: "unmeasured", samples: 9 });
  assert.equal(memoryLine(limit), "Sandbox memory: no limit (9 of the 10 gate samples a measured limit needs; memory in the project config sets one)");
  assert.deepEqual(memoryLimit(undefined, sandboxes(20, 3000, 3500, "other"), "p1", NOW), { from: "unmeasured", samples: 0 }, "another project's samples are not this one's");
});

test("the default's window reaches back for gate samples, not lines: lines with no gate figure do not leave it short", () => {
  // Two sandboxes a run, `withGate` of them with a gate figure (the other's ticket failed before its first gate).
  const run = (i: number, withGate: number) =>
    Array.from({ length: 2 }, (_, j) => ({ ts: `2026-05-0${9 - i}T00:00:00.000Z`, project: "p1", run: `r${i}`, peakMib: 3000, sampled: 2, ...(j < withGate ? { anonMib: 3000 } : {}) }));
  // Five runs of two lines each, 9 gate samples among them (10 lines): a window by lines stops there, at 9 of 10.
  const recent = [run(0, 2), run(1, 2), run(2, 2), run(3, 2), run(4, 1)].flat();
  const older = run(5, 2);
  assert.deepEqual(memoryLimit(undefined, recent, "p1", NOW), { from: "unmeasured", samples: 9 });
  assert.deepEqual(memoryLimit(undefined, [...recent, ...older], "p1", NOW), { bytes: 4608 * MIB, from: "measured", anonMib: 3000 });
});

test("a number is the limit, cut to the VM, and false is none", () => {
  assert.equal(memoryLine(memoryLimit(6 * GIB, [], "p1", NOW, 16 * GIB)), "Sandbox memory: 6 GiB each (memory in the project config)");
  assert.equal(memoryLine(memoryLimit(16 * GIB, [], "p1", NOW, 9.8 * GIB)), "Sandbox memory: 9.8 GiB each (memory in the project config, the VM's whole memory)");
  assert.deepEqual(memoryLimit(false, sandboxes(10, 3000), "p1", NOW), { from: "off" });
  assert.equal(memoryLine({ from: "off" }), "Sandbox memory: no limit (memory: false)");
});

test("sandboxMemory reads the project's own peaks by its root's hash, and the VM from docker info", () => {
  const root = join(tmp, "measured");
  mkdirSync(root, { recursive: true });
  const peaks = () => sandboxes(10, 3000, undefined, projectId(root));
  const info = () => JSON.stringify({ MemTotal: 4 * GIB });
  assert.deepEqual(sandboxMemory({ root }, info, peaks, NOW), { bytes: 4 * GIB, capped: true, from: "measured", anonMib: 3000 });
  assert.equal(sandboxMemory({ root }, () => undefined, peaks, NOW).bytes, 4608 * MIB, "no docker info caps nothing");
  assert.deepEqual(sandboxMemory({ root }, info, () => { throw new Error("unreadable"); }, NOW), { from: "unmeasured", samples: 0 });
});

// ---- applying it ----

test("limitMemory sets memory and swap to the limit by the container's name, and nothing with no limit", async () => {
  writeFileSync(calls, "");
  const box = { sandboxId: "sandcastle-0123abcd", exec: async () => ({ exitCode: 0, stdout: "" }) };
  assert.equal(await limitMemory(box, 2 * GIB), box);
  await limitMemory(box, false);
  await limitMemory(box, undefined);
  assert.deepEqual(seen(), [`docker update --memory ${2 * GIB} --memory-swap ${2 * GIB} sandcastle-0123abcd`]);
});

test("a failed update says one line and the sandbox opens with none", async () => {
  writeFileSync(calls, "");
  process.env.FAKE_DOCKER_FAIL = "1";
  const lines: string[] = [];
  try {
    const box = { sandboxId: "sandcastle-0123abcd", exec: async () => ({ exitCode: 0, stdout: "" }) };
    assert.equal(await limitMemory(box, 2 * GIB, (l) => lines.push(l)), box);
  } finally {
    delete process.env.FAKE_DOCKER_FAIL;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not set the sandbox's memory limit to 2 GiB: .*; it runs with none/);
});

test("a kernel that refuses the swap limit still gets the memory limit, and says so", async () => {
  writeFileSync(calls, "");
  process.env.FAKE_SWAP_FAIL = "1";
  const lines: string[] = [];
  try {
    await limitMemory({ sandboxId: "sandcastle-0123abcd", exec: async () => ({ exitCode: 0, stdout: "" }) }, 2 * GIB, (l) => lines.push(l));
  } finally {
    delete process.env.FAKE_SWAP_FAIL;
  }
  assert.deepEqual(seen(), [`docker update --memory ${2 * GIB} --memory-swap ${2 * GIB} sandcastle-0123abcd`, `docker update --memory ${2 * GIB} sandcastle-0123abcd`]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /the sandbox's swap could not be limited \(.*swap limit.*\): its memory is limited to 2 GiB, its swap is not/);
});

// ---- an OOM kill, named ----

/**
 * A sandbox whose kernel's `memory.events` answers from `k`, and whose gates (`run-tests`, `typecheck`) do what `k.gates`
 * says in turn: `own` is killed at the sandbox's own limit (`oom` and `oom_kill` rise), `vm` by the VM's killer (`oom_kill`
 * alone), `red` fails an assertion, `green` passes.
 */
const kernel = (gates: ("own" | "vm" | "red" | "green")[]) => {
  const k = { oom: 0, kills: 0 };
  return {
    k,
    box: {
      exec: async (cmd: string) => {
        if (cmd.includes("memory.events")) return { exitCode: 0, stdout: `low 0\nhigh 0\nmax ${k.oom * 3}\noom ${k.oom}\noom_kill ${k.kills}\noom_group_kill 0\n`, stderr: "" };
        if (!/run-tests|typecheck/.test(cmd)) return { exitCode: 0, stdout: "", stderr: "" };
        const how = gates.shift();
        if (how === "own") k.oom++;
        if (how === "own" || how === "vm") {
          k.kills++;
          return { exitCode: 137, stdout: "running tests", stderr: "Killed" };
        }
        return how === "red" ? { exitCode: 1, stdout: "1 failed: expected 2, got 3", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
};
const gated = (names: string[], memory?: number) => ({ name: "fixture", root: tmp, ...(memory ? { memory } : {}), gates: names.map((name) => ({ name, command: name === "typecheck" ? "typecheck" : "run-tests" })) }) as Parameters<typeof runGates>[0];
const OWN = "out of memory: killed a process at the sandbox's 2 GiB limit (`memory` in the project config sets it)";
const VM = "out of memory: the VM ran out and killed a process here (lower maxSandboxes, or give the VM more memory)";

test("a gate killed at the sandbox's limit is red with the cause named, in its failure, its output and its log", async () => {
  const log = join(tmp, "gates.log");
  writeFileSync(log, "");
  const run = await runGates(gated(["test"], 2 * GIB), kernel(["own"]).box, "gates", false, { log });
  assert.equal(run.failure?.oom, OWN);
  assert.equal(run.failure?.exitCode, 137);
  assert.ok(run.failure?.output.endsWith(`[sandcastle] ${OWN}`), run.failure?.output);
  assert.equal(exitWords(run.failure!), `exit 137, ${OWN}`);
  assert.ok(readFileSync(log, "utf8").includes(`# test RED (exit 137, ${OWN})`));
});

test("a kill under the sandbox's own limit is the VM's, and says to run fewer sandboxes, not to raise memory", async () => {
  const run = await runGates(gated(["test"], 2 * GIB), kernel(["vm"]).box, "gates");
  assert.equal(run.failure?.oom, VM);
  assert.doesNotMatch(VM, /`memory`/);
  // With no limit at all, every kill is the VM's.
  assert.equal((await runGates(gated(["test"]), kernel(["vm"]).box, "gates")).failure?.oom, VM);
});

test("a kill is told only to the gate it happened in: a later plain red in the same pass is a plain exit", async () => {
  const run = await runGates(gated(["typecheck", "test"], 2 * GIB), kernel(["own", "red"]).box, "gates", true);
  assert.deepEqual(run.failures.map((f) => [f.name, f.exitCode, f.oom]), [["typecheck", 137, OWN], ["test", 1, undefined]]);
  assert.doesNotMatch(run.failures[1].output, /out of memory/);
  // A kill in a green gate (a worker the runner restarted) is not told to the red one after it either.
  const after = await runGates(gated(["typecheck", "test"], 2 * GIB), kernel(["green", "red"]).box, "gates", true);
  assert.equal(after.failures[0].oom, undefined);
});

test("a red gate with no kill, or a kernel with no memory.events, is a plain exit", async () => {
  const plain = await runGates(gated(["test"]), { exec: async (cmd: string) => (cmd.includes("run-tests") ? { exitCode: 137, stdout: "", stderr: "Killed" } : { exitCode: 1, stdout: "", stderr: "" }) }, "gates");
  assert.equal(plain.failure?.oom, undefined);
  assert.equal(exitWords(plain.failure!), "exit 137");
  assert.equal(oomNote({ oom: 1, kills: 2 }, { oom: 1, kills: 2 }, 2 * GIB), undefined);
  assert.equal(oomNote(undefined, { oom: 1, kills: 3 }, 2 * GIB), undefined);
  assert.equal(oomNote({ oom: 0, kills: 0 }, { oom: 1, kills: 2 }, false), "out of memory: killed 2 processes at the sandbox's limit (`memory` in the project config sets it)");
  assert.equal(await oomKills({ exec: async () => ({ exitCode: 1, stdout: "" }) }), undefined);
  assert.equal(await oomKills({ exec: async () => ({ exitCode: 0, stdout: "oom_kill 1\n" }) }), undefined, "a file with no oom line is not read as one");
});

test("an agent error carries the words on its first line, which the ticket's note keeps", () => {
  const e = withOom(new Error("claude-code agent failed:\nexited with code 137: Killed"), VM) as Error;
  assert.equal(e.message.split("\n")[0], `claude-code agent failed - ${VM}`);
  assert.equal(agentFailure(e), `claude-code agent failed - ${VM}`);
  assert.equal(withOom("not an error", VM), "not an error");
});

// ---- no PSI ----

test("a sandbox whose kernel has no PSI is said once, and a kernel with it says nothing", async () => {
  const said: string[] = [];
  const box = (psi: boolean) => ({
    exec: async (cmd: string) => {
      if (cmd.includes("memory.stat")) return { exitCode: 0, stdout: `anon ${900 * MIB}\n` };
      if (cmd.includes("memory.pressure")) return psi ? { exitCode: 0, stdout: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n" } : { exitCode: 1, stdout: "" };
      return { exitCode: 1, stdout: "" };
    },
  });
  // The run's state across its turns: each turn sets the line again, and a turn after the one that said it does not.
  const run = { told: false };
  const tell = () => void said.push("no psi");
  onNoPsi(tell, run);
  try {
    await sampling(box(true), "gate", async () => "done");
    assert.deepEqual(said, []);
    await sampling(box(false), "gate", async () => "done");
    await sampling(box(false), "agent", async () => "done");
    assert.deepEqual(said, ["no psi"]);
    onNoPsi(tell, run);
    await sampling(box(false), "gate", async () => "done");
    assert.deepEqual(said, ["no psi"], "a second turn of the same run says nothing");
    onNoPsi(tell, { told: false });
    await sampling(box(false), "gate", async () => "done");
    assert.deepEqual(said, ["no psi", "no psi"], "another run says it again");
  } finally {
    onNoPsi(undefined);
  }
});
