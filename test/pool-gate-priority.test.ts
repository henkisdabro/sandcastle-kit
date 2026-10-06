// A freed machine-wide gates slot goes to the run that has waited longest, as before; within that
// run, a gate the run's end waits on (a landing's, the base check's, the verify's) takes it before
// the run's ticket gates (`withSlot`'s `priority`, passed by `runGates`; src/pool.ts).
//
// This process is one run and the other is a file (test/pool-sim.ts), as in test/pool-shares.test.ts:
// the slot logic runs in process with a short poll, so no test waits on a real one. The gates pool
// there has one slot, so one waiter's holding it is every other waiter's wait.
//
//   node --test test/pool-gate-priority.test.ts

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, pool, POLL, RUN_ID, said, slots, sleep, steady, until } from "./pool-sim.ts";

const { runGates } = await import("../src/gates.ts");
const { slotsByRun, withSlot } = pool;

const made: { release: () => void; done: Promise<void> }[] = [];
// A test that fails leaves its gates waiting: they are released and finish, so the file ends instead of polling for ever.
afterEach(async () => {
  const gates = made.splice(0);
  for (const g of gates) g.release();
  await cleanup();
  await Promise.allSettled(gates.map((g) => g.done));
});

/** One gate of this run asking for the one gates slot: it records that it holds it, and keeps it until `release()`. */
const gate = (log: string[], label: string, { poll = POLL, priority = false } = {}) => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const g = { waits: false, held: false, release, done: undefined as unknown as Promise<void> };
  g.done = withSlot(
    "gates",
    label,
    async () => {
      g.held = true;
      log.push(label);
      await hold;
    },
    () => (g.waits = true),
    poll,
    priority,
  );
  made.push(g);
  return g;
};

const OTHER = "run-y";
const OTHER_PID = 1_000_100;
/** The other run's gate waiting for the gates slot since `since`, written the way the pool writes an entry; returns a function that ends the wait. */
const otherWaits = (since: number) => {
  const waits = join(slots, "waits");
  mkdirSync(waits, { recursive: true });
  const file = join(waits, `gates-${since}-${OTHER}-0.wait`);
  writeFileSync(file, `${OTHER_PID} ${OTHER} ${since} a ticket gate\n`);
  return () => rmSync(file);
};
/** The other run's gate holds the one gates slot, as the pool writes its lock; returns a function that frees it. */
const otherHolds = () => {
  const file = join(slots, "gates-0.lock");
  writeFileSync(file, `${OTHER_PID} token-y run=${OTHER} a ticket gate\n`);
  return () => rmSync(file);
};
const mineHeld = () => slotsByRun("gates").get(RUN_ID) ?? 0;

test("a landing gate takes a freed gates slot before the same run's ticket gate that waited first", async () => {
  const log: string[] = [];
  const holder = gate(log, "holder");
  await until(() => holder.held, "the holder's slot");
  // The ticket gate polls far more often and began waiting first: only the priority can put the landing gate ahead of it.
  const ticket = gate(log, "ticket gate");
  await until(() => ticket.waits, "the ticket gate's wait");
  const landing = gate(log, "landing gate", { poll: 40, priority: true });
  await until(() => landing.waits, "the landing gate's wait");

  holder.release();
  await until(() => landing.held, "the landing gate's slot");
  assert.deepEqual(log, ["holder", "landing gate"], "the ticket gate waits while a landing gate does");

  landing.release();
  await until(() => ticket.held, "the ticket gate's slot, once the landing gate is done");
  ticket.release();
  await Promise.all([holder.done, ticket.done, landing.done]);
  assert.deepEqual(log, ["holder", "landing gate", "ticket gate"]);
});

test("a ticket gate that asks while a landing gate waits says it leaves the slot to it", async () => {
  const log: string[] = [];
  const holder = gate(log, "holder");
  await until(() => holder.held, "the holder's slot");
  const landing = gate(log, "landing gate", { poll: 40, priority: true });
  await until(() => landing.waits, "the landing gate's wait");
  const ticket = gate(log, "ticket gate");
  await until(() => ticket.waits, "the ticket gate's wait");

  assert.ok(said.some((line) => /ticket gate: waiting for a machine-wide gates slot \(a landing, base or verify gate of this run goes first\)/.test(line)), said.join("\n"));
  holder.release();
  await until(() => landing.held, "the landing gate's slot");
  landing.release();
  await until(() => ticket.held, "the ticket gate's slot");
  ticket.release();
  await Promise.all([holder.done, ticket.done, landing.done]);
  assert.deepEqual(log, ["holder", "landing gate", "ticket gate"]);
});

test("across runs the longest wait still wins: another run's older ticket gate is served before this run's landing gate", async () => {
  const log: string[] = [];
  const holder = gate(log, "holder");
  await until(() => holder.held, "the holder's slot");
  const otherStops = otherWaits(Date.now() - 60_000);
  const landing = gate(log, "landing gate", { priority: true });
  await until(() => landing.waits, "the landing gate's wait");

  // The slot is free and the landing gate polls every few milliseconds, but the other run has waited longer.
  holder.release();
  await holder.done;
  await steady(() => !landing.held && mineHeld() === 0, "the landing gate left the free slot to the run that waited longer", 150);

  // The other run's gate takes it, and this run's landing gate goes on waiting for it.
  otherStops();
  const otherFrees = otherHolds();
  await steady(() => !landing.held, "the landing gate waited while the other run held the slot");
  otherFrees();
  await until(() => landing.held, "the landing gate's slot, once the other run's is free");
  landing.release();
  await landing.done;
});

test("a landing gate counts from its run's oldest wait: the run that waited longest is served, by its landing gate", async () => {
  const log: string[] = [];
  const holder = gate(log, "holder");
  await until(() => holder.held, "the holder's slot");
  const ticket = gate(log, "ticket gate", { poll: 40 });
  await until(() => ticket.waits, "the ticket gate's wait");
  await sleep(5);
  // The other run began waiting after this run's ticket gate, and before its landing gate.
  otherWaits(Date.now());
  await sleep(5);
  const landing = gate(log, "landing gate", { priority: true });
  await until(() => landing.waits, "the landing gate's wait");

  // This run is the longest wait, so it is served, and its landing gate is the one of its gates that takes the slot.
  // Counted from its own start the landing gate would leave the slot to the other run, and the ticket gate to the landing gate.
  holder.release();
  await until(() => landing.held, "the landing gate's slot");
  assert.equal(ticket.held, false);
  landing.release();
  await until(() => ticket.held, "the ticket gate's slot");
  ticket.release();
  await Promise.all([holder.done, ticket.done, landing.done]);
  assert.deepEqual(log, ["holder", "landing gate", "ticket gate"]);
});

// runGates is where a caller asks for the priority; the fake sandbox runs nothing, and the wait's poll (5 s in a run) is the mocked clock's.
test("runGates with priority takes the freed gates slot before the run's ticket gates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const project = { name: "fixture", gates: [{ name: "lint", command: "run-lint" }] } as Parameters<typeof runGates>[0];
  const ran: string[] = [];
  const box = (who: string) => ({
    exec: async (cmd: string) => {
      if (cmd.includes("run-lint")) ran.push(who);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  let release!: () => void;
  const holder = withSlot("gates", "holder", () => new Promise<void>((r) => (release = r)));
  const ticket = runGates(project, box("ticket"), "fixture #1 gates");
  const landing = runGates(project, box("landing"), "fixture #2 landing gate", false, {}, true);
  release();
  const all = Promise.all([holder, ticket, landing]);
  let done = false;
  void all.then(() => (done = true));
  for (let i = 0; i < 20 && !done; i++) {
    t.mock.timers.tick(5_000);
    await new Promise((r) => setImmediate(r));
  }
  await all;
  assert.deepEqual(ran, ["landing", "ticket"]);
});

// The callers' wiring: burndown's landing gate, `sandcastle land` and the base and verify gates ask for the priority, a ticket's gate does not.
test("the landing, base and verify gates ask for priority and a ticket's gate does not", () => {
  const src = (file: string) => readFileSync(join(import.meta.dirname, "../src", file), "utf8");
  assert.match(src("burndown.ts"), /runGates\(box, id, "landing gate", true\)/);
  assert.match(src("burndown.ts"), /gate: \(box, id\) => runGates\(box, id\),/);
  assert.match(src("land.ts"), /runGates\(project, box, `\$\{ref\} land gates`, false, \{ log \}, true\)/);
  // gateBase: the base and verify gates take a sandbox slot of their own; the mid-run check runs in a ticket's.
  assert.match(src("gates.ts"), /runGates\(project, sandbox, `\$\{project\.name\} \$\{label\}`, true, undefined, ownSlot\)/);
});
