// A ticket's gates run in the ticket's own sandbox, whose `--cpus` was fixed at its creation as the ticket share of the
// VM; a landing's sandbox has the gate share (VM over `maxGates`). While a ticket's gates hold a gates slot they are one
// of at most `maxGates` suites, so the container is raised to the gate share with `docker update --cpus` and put back
// when the slot is released - after a red, a throw too. A failed read or update says one line and never fails the gate.
// A fake `docker` on PATH logs each call, and the fake sandbox's gate writes into the same log, so the order is read
// from one file. No Docker, model or network.
//
//   pnpm test:file test/ticket-gate-cpus.test.ts

import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, said } from "./pool-sim.ts";

const { runGates } = await import("../src/gates.ts");

afterEach(cleanup);

const dir = mkdtempSync(join(tmpdir(), "sandcastle-ticket-gate-cpus-"));
const calls = join(dir, "calls");
writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "docker $*" >> '${calls}'\n[ -n "$FAKE_DOCKER_FAIL" ] && echo "no such container" >&2 && exit 1\nexit 0\n`);
chmodSync(join(dir, "docker"), 0o755);
process.env.PATH = [dir, process.env.PATH ?? ""].join(delimiter);

const project = { name: "fixture", gates: [{ name: "test", command: "run-tests" }] } as Parameters<typeof runGates>[0];

/** A sandbox whose container id is `abc123`; its gate logs `gate`, and is red (exit 1) or throws when asked. */
const sandbox = (how: "green" | "red" | "throws", hostname = "abc123\n") => ({
  exec: async (cmd: string) => {
    if (cmd === "hostname") return { exitCode: hostname ? 0 : 1, stdout: hostname, stderr: "" };
    if (!cmd.includes("run-tests")) return { exitCode: 0, stdout: "", stderr: "" };
    appendFileSync(calls, "gate\n");
    if (how === "throws") throw new Error("the sandbox died");
    return { exitCode: how === "red" ? 1 : 0, stdout: "", stderr: how === "red" ? "boom" : "" };
  },
});

const seen = () => {
  try {
    return readFileSync(calls, "utf8").trim().split("\n");
  } catch {
    return [];
  }
};
const fresh = () => {
  writeFileSync(calls, "");
  said.length = 0;
  delete process.env.FAKE_DOCKER_FAIL;
};
const asTicket = { cpus: { gate: 4, ticket: 2 } };

test("a ticket's green gate runs at the gate share and the limit goes back to the ticket share", async () => {
  fresh();
  const run = await runGates(project, sandbox("green"), "ticket", false, asTicket);
  assert.equal(run.failure, undefined);
  assert.deepEqual(seen(), ["docker update --cpus 4 abc123", "gate", "docker update --cpus 2 abc123"]);
});

test("a ticket's red gate puts the limit back too", async () => {
  fresh();
  const run = await runGates(project, sandbox("red"), "ticket", false, asTicket);
  assert.equal(run.failure?.name, "test");
  assert.deepEqual(seen(), ["docker update --cpus 4 abc123", "gate", "docker update --cpus 2 abc123"]);
});

test("a gate that throws puts the limit back before the error leaves", async () => {
  fresh();
  await assert.rejects(runGates(project, sandbox("throws"), "ticket", false, asTicket), /the sandbox died/);
  assert.deepEqual(seen(), ["docker update --cpus 4 abc123", "gate", "docker update --cpus 2 abc123"]);
});

test("a gate run with no limit to move (cpus: false, or a landing's sandbox) makes no update", async () => {
  fresh();
  await runGates(project, sandbox("green"), "landing", false, {}, true);
  assert.deepEqual(seen(), ["gate"]);
});

test("a gate share no larger than the ticket's is not applied: nothing is raised", async () => {
  fresh();
  await runGates(project, sandbox("green"), "ticket", false, { cpus: { gate: 2, ticket: 2 } });
  assert.deepEqual(seen(), ["gate"]);
});

test("a failed update says one line, leaves the limit as it was and the gate runs", async () => {
  fresh();
  process.env.FAKE_DOCKER_FAIL = "1";
  const run = await runGates(project, sandbox("green"), "ticket", false, asTicket);
  assert.equal(run.failure, undefined);
  assert.deepEqual(seen(), ["docker update --cpus 4 abc123", "gate"]);
  assert.equal(said.filter((l) => l.includes("CPU limit")).length, 1);
});

test("an unreadable container id says one line and the gate runs without an update", async () => {
  fresh();
  const run = await runGates(project, sandbox("green", ""), "ticket", false, asTicket);
  assert.equal(run.failure, undefined);
  assert.deepEqual(seen(), ["gate"]);
  assert.equal(said.filter((l) => l.includes("container id")).length, 1);
});

// burndown() needs Docker, so no test drives it: the call site is held by its text.
test("burndown() hands a ticket's gates both shares, and a landing's gates none", () => {
  const source = readFileSync(new URL("../src/burndown.ts", import.meta.url), "utf8");
  assert.match(source, /\.\.\.\(!priority && ticketCpus !== undefined && gateCpus !== undefined \? \{ cpus: \{ gate: gateCpus, ticket: ticketCpus \} \} : \{\}\)/);
});
