// A failed setup step is named, never silent. Sandcastle ignores a ready hook's exit status (0.12.0 to 0.14.0) or
// rejects the open on it (a later release), so the kit's setup hook records how it ended and the kit reads that record
// after the open (`setupHook`, `parseSetupState`, `assertSetup` in src/sandbox.ts). At the base gates a failed step is a
// red `setup` gate (`gateResultLines`); for a ticket it costs the attempt and the scheduler sends the ticket back once
// (`createSchedule` in src/schedule.ts), then a second failure ends it as crashed with the step in its note.
// The hook runs here with the host's sh, its record moved into a temp directory. No Docker, no model.
//
//   pnpm test:file test/setup-failure.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pool.ts and sandbox.ts derive their directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { assertSetup, parseSetupState, setupHook, SETUP_READ } = await import("../src/sandbox.ts");
const { SetupFailed } = await import("../src/errors.ts");
const { gateResultLines } = await import("../src/gates.ts");
const { createSchedule } = await import("../src/schedule.ts");
const { agentFailure } = await import("../src/agents.ts");
const { quietly } = await import("./quiet.ts");

// The hook and the read as a sandbox runs them, with the record in a directory of the test's own instead of /tmp.
const inSandbox = (setup: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-setup-"));
  const local = (script: string) => script.replaceAll("/tmp/sandcastle-setup", join(dir, "state"));
  const sh = (script: string) => execFileSync("sh", ["-c", local(script)], { cwd: dir, encoding: "utf8" });
  const hookOut = sh(setupHook(setup));
  return { dir, hookOut, read: () => parseSetupState(sh(SETUP_READ), setup), box: { exec: async (c: string) => ({ stdout: sh(c) }) } };
};

test("every step passing reads as no failure, and the hook prints nothing of their output", () => {
  const s = inSandbox(["echo one", "echo two # a trailing comment", "true"]);
  assert.equal(s.hookOut, "");
  assert.equal(s.read(), undefined);
});

test("a failed step is named with its exit status and output, and the steps after it do not run", () => {
  const s = inSandbox(["echo one", "echo installing; echo 'npm ERR! code E404' >&2; exit 3", "touch never"]);
  const failure = s.read();
  assert.equal(failure?.name, "setup");
  assert.equal(failure?.command, "echo installing; echo 'npm ERR! code E404' >&2; exit 3");
  assert.equal(failure?.exitCode, 3);
  assert.match(failure?.output ?? "", /installing\nnpm ERR! code E404/);
  assert.equal(existsSync(join(s.dir, "never")), false);
});

test("the hook itself always exits 0: a later Sandcastle that rejects the open on a hook's status sees no failure of it", () => {
  // execFileSync throws on a non-zero exit, so reaching the read is the proof.
  const s = inSandbox(["exit 7"]);
  assert.equal(s.read()?.exitCode, 7);
});

test("no record at all is a setup that never finished", () => {
  const failure = parseSetupState("@@output\n", ["pnpm install", "pnpm build"]);
  assert.equal(failure?.exitCode, -1);
  assert.equal(failure?.command, "pnpm install && pnpm build");
  assert.match(new SetupFailed(failure!).message, /^setup failed: `pnpm install && pnpm build` did not finish/);
});

test("assertSetup returns the sandbox when setup passed, and throws SetupFailed with the step and its last line when not", async () => {
  const ok = inSandbox(["true"]);
  assert.equal(await assertSetup(ok.box, ["true"], "agent/issue-1"), ok.box);
  const bad = inSandbox(["echo first; echo 'npm ERR! network timeout'; exit 1"]);
  const { result: error, lines } = await quietly(() => assertSetup(bad.box, ["echo first; echo 'npm ERR! network timeout'; exit 1"], "agent/issue-1").then(() => undefined, (e: unknown) => e));
  assert.ok(error instanceof SetupFailed);
  // The output's tail is printed under the label, for the run's output.
  assert.match(lines.join("\n"), /^agent\/issue-1: setup failed: .*; last lines:\nfirst\nnpm ERR! network timeout/);
  assert.equal(error.message, "setup failed: `echo first; echo 'npm ERR! network timeout'; exit 1` exited 1 - npm ERR! network timeout");
  // The crashed note is agentFailure's reading of it: the step and the output's last line.
  assert.equal(agentFailure(error), "setup failed: `echo first; echo 'npm ERR! network timeout'; exit 1` exited 1 - npm ERR! network timeout");
});

test("a project with no setup is never read", async () => {
  const box = { exec: async () => assert.fail("no read without setup") };
  assert.equal(await assertSetup(box, [], "x"), box);
});

test("the base check's result lines name the failed setup step, not the first gate's command", () => {
  const failure = { name: "setup", command: "npm ci", exitCode: 1, output: "boom" };
  assert.deepEqual(gateResultLines([{ name: "test", command: "npm test" }], [{ name: "setup", pass: false }], failure), ["  FAIL  setup  $ npm ci"]);
  assert.deepEqual(gateResultLines([{ name: "test", command: "npm test" }], [{ name: "test", pass: true }]), ["  pass  test  $ npm test"]);
});

type T = { id: string };
type G = { issue: string };
const setupError = () => new SetupFailed({ name: "setup", command: "npm ci", exitCode: 1, output: "npm ERR! network" });

test("a ticket whose setup failed is sent back once and lands on its second attempt", async () => {
  const told: unknown[] = [];
  const { endings } = await createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    attempt: async (t, at) => (at.n === 1 ? { kind: "crashed", error: setupError() } : { kind: "green", green: { issue: t.id } }),
    land: async () => ({ kind: "merged" }) as const,
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c),
  });
  const one = endings.get("1");
  assert.equal(one?.kind, "landing");
  assert.equal(one?.kind === "landing" && one.attempts, 2);
  assert.deepEqual(told.find((c) => (c as { kind: string }).kind === "requeued"), {
    kind: "requeued",
    id: "1",
    again: { kind: "setup", with: [], setup: "setup failed: `npm ci` exited 1 - npm ERR! network" },
  });
});

test("a second failed setup ends the ticket as crashed after two attempts", async () => {
  let n = 0;
  const { endings } = await createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    attempt: async () => (n++, { kind: "crashed", error: setupError() }),
    land: async () => ({ kind: "merged" }) as const,
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  const one = endings.get("1");
  assert.equal(n, 2);
  assert.equal(one?.kind, "crashed");
  assert.equal(one?.kind === "crashed" && one.attempts, 2);
  assert.ok(one?.kind === "crashed" && one.error instanceof SetupFailed);
});

test("any other crash is not sent back", async () => {
  let n = 0;
  const { endings } = await createSchedule<T, G, string, string>({ tickets: [{ id: "1" }] }).run({
    workers: 1,
    attempt: async () => (n++, { kind: "crashed", error: new Error("claude-code exited with code 1") }),
    land: async () => ({ kind: "merged" }) as const,
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  assert.equal(n, 1);
  assert.equal(endings.get("1")?.kind, "crashed");
});

test("the requeue's line and a later collision's note say the setup failed", async () => {
  const { againLine, requeuedLine } = await import("../src/landing.ts");
  assert.equal(requeuedLine("setup", [], { setup: "setup failed: `npm ci` exited 1 - npm ERR! network" }), "requeued after setup failed: `npm ci` exited 1 - npm ERR! network");
  assert.equal(againLine("conflict", ["2"], undefined, "setup"), "conflicted with #2 after a requeue for a failed setup");
});

test("a step's own set -e is honoured: a failure inside it is the step's failure", () => {
  const s = inSandbox(["set -e; false; echo after"]);
  const failure = s.read();
  assert.equal(failure?.exitCode, 1);
  assert.equal(failure?.output, "");
});

test("each step runs in a shell of its own, as the && chain of subshells before it did: a cd or export does not reach the next", () => {
  const s = inSandbox(["mkdir sub && cd sub && export SETUP_X=1", "pwd >where; echo \"x=${SETUP_X:-}\" >>where"]);
  assert.equal(s.read(), undefined);
  const [where, x] = readFileSync(join(s.dir, "where"), "utf8").trim().split("\n");
  assert.equal(realpathSync(where), realpathSync(s.dir));
  assert.equal(x, "x=");
});

test("the output's colour codes and \\r progress lines are taken out, and a long tail is clipped", () => {
  const failure = parseSetupState("fail 0 1\n@@output\n\u001b[31mred\u001b[0m\nloading 10%\rloading 100%\r\nend\r\n", ["npm ci"]);
  assert.equal(failure?.output, "red\nloading 100%\nend");
  const long = parseSetupState(`fail 0 1\n@@output\n${"x".repeat(9000)}\n`, ["npm ci"]);
  assert.ok(long!.output.length <= 4005 && long!.output.startsWith("[...]"), String(long!.output.length));
  // The message keeps the last line short: it is the ticket's note and the requeue line.
  assert.ok(new SetupFailed(long!).message.length < 200);
});

test("two tickets whose setup fails the same way stop the run starting tickets, with sandcastle gates as the next step", async () => {
  const { setupProblemWords } = await import("../src/ledger.ts");
  const started: string[] = [];
  const told: { kind: string; line?: string }[] = [];
  const { endings, stop } = await createSchedule<T, G, string, string>({ tickets: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }] }).run({
    workers: 1,
    attempt: async (t) => (started.push(t.id), { kind: "crashed", error: setupError() }),
    land: async () => ({ kind: "merged" }) as const,
    host: { check: async () => {}, failed: undefined },
    tell: (c) => void told.push(c as never),
  });
  assert.ok(!started.includes("3") && !started.includes("4"), started.join());
  assert.equal(stop.headline?.kind, "setup problem");
  assert.equal(told.filter((c) => c.kind === "setup problem").length, 1);
  for (const id of ["1", "2"]) assert.equal(endings.get(id)?.kind, "crashed");
  const words = setupProblemWords(setupError().message);
  assert.match(words, /`setup` failed alike/);
  assert.match(words, /sandcastle gates/);
  assert.doesNotMatch(words, /doctor --verify/);
});

test("setup failures of different steps do not stop the run", async () => {
  const started: string[] = [];
  const step = (id: string) => new SetupFailed({ name: "setup", command: `step-${id}`, exitCode: 1, output: "" });
  await createSchedule<T, G, string, string>({ tickets: [{ id: "1" }, { id: "2" }, { id: "3" }] }).run({
    workers: 1,
    attempt: async (t) => (started.push(t.id), { kind: "crashed", error: step(t.id) }),
    land: async () => ({ kind: "merged" }) as const,
    host: { check: async () => {}, failed: undefined },
    tell: () => {},
  });
  assert.ok(["1", "2", "3"].every((id) => started.includes(id)), started.join());
});

test("a crash after a setup requeue says so once, and clears the requeue line; an unstarted one clears it too", async () => {
  const { describe } = await import("../src/ledger.ts");
  const requeued = `requeued after ${setupError().message}`;
  const again = describe({ kind: "crashed", error: setupError(), attempts: 2 }, { base: "main", gateNames: "test", requeued });
  assert.deepEqual(again.record, { state: "crashed", note: "setup failed again after a requeue: `npm ci` exited 1 - npm ERR! network", requeued: null });
  const unstarted = describe({ kind: "crashed", error: setupError(), attempts: 1 }, { base: "main", gateNames: "test", requeued });
  assert.equal(unstarted.record?.requeued, null);
  // A crash after a conflict's requeue keeps the line: it says something the note does not.
  const other = describe({ kind: "crashed", error: new Error("boom"), attempts: 2 }, { base: "main", gateNames: "test", requeued: "requeued after conflict at landing with #2" });
  assert.equal(other.record?.requeued, undefined);
});
