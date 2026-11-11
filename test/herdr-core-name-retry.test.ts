// herdr-core: `get` answers "not one to reuse" for any hc error, so a failed `get <name>` reads as a free name and
// `run --name` then fails as taken. The status view is opened once more unnamed when hc itself throws, and only then.
//
//   pnpm test:file test/herdr-core-name-retry.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quietly } from "./quiet.ts";

const { openCoreStatus, statusName } = await import("../src/herdr-core.ts");

type Reply = string | Error;
// A fake hc: `get` of the status name answers `get`, `run` answers each reply of `runs` in turn.
const fake = (opts: { get: (n: number) => Reply; runs: Reply[] }) => {
  const calls: string[][] = [];
  let gets = 0;
  const answer = (r: Reply) => {
    if (r instanceof Error) throw r;
    return r;
  };
  const hc = (args: string[]) => {
    calls.push(args);
    if (args[0] === "get") return answer(opts.get(gets++));
    if (args[0] === "run") return answer(opts.runs[calls.filter((c) => c[0] === "run").length - 1] ?? new Error("no more runs"));
    return "{}";
  };
  return { hc, runs: () => calls.filter((c) => c[0] === "run") };
};
const failure = (stderr: string) => Object.assign(new Error("Command failed"), { stderr });
const setUp = () => {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-core-retry-"))), "repo");
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  return root;
};
const caller = { address: "t-mine", pid: 1, labels: {} };
const open = (root: string, hc: (a: string[]) => string) => quietly(() => openCoreStatus(root, caller, { kit: "/k", instance: "i2", hc }));
const taken = failure("name is taken");

test("a failed get that read as a free name opens the status view unnamed, with the line that the old one is to be closed by hand", async () => {
  const root = setUp();
  const f = fake({ get: () => failure("hc unreachable"), runs: [taken, '{"address":"t9"}'] });
  const { result, lines } = await open(root, f.hc);
  assert.equal(result, "t9");
  assert.equal(f.runs().length, 2);
  assert.equal(f.runs()[0][f.runs()[0].indexOf("--name") + 1], statusName(root));
  assert.ok(!f.runs()[1].includes("--name"), f.runs()[1].join(" "));
  assert.deepEqual(lines, [`The status view's name ${statusName(root)} is still taken, so this run's status view is unnamed beside it: close the old one yourself.`]);
});

test("a name the kit tried to free and cannot read back keeps the could-not-be-removed line when the unnamed retry opens", async () => {
  const root = setUp();
  // get(name) finds a finished terminal, hc removes it, and the name asked again fails to answer.
  const f = fake({
    get: (n) => (n === 0 ? JSON.stringify({ address: "t3", state: "finished", labels: {} }) : failure("hc unreachable")),
    runs: [taken, '{"address":"t9"}'],
  });
  const { result, lines } = await open(root, f.hc);
  assert.equal(result, "t9");
  assert.ok(!f.runs()[1].includes("--name"));
  assert.deepEqual(lines, ["The old status terminal t3 could not be removed, so this run's status view is unnamed beside it: close it yourself."]);
});

test("both runs failing gives no view, the second error in the line and no unnamed line", async () => {
  const root = setUp();
  const f = fake({ get: () => failure("hc unreachable"), runs: [failure("first: name taken"), failure("second: socket closed")] });
  const { result, lines } = await open(root, f.hc);
  assert.equal(result, undefined);
  assert.equal(f.runs().length, 2);
  assert.deepEqual(lines, ["Could not open the status view in herdr-core (second: socket closed)."]);
});

test("a run that answers with no address is not retried", async () => {
  const root = setUp();
  const f = fake({ get: () => failure("not found"), runs: ["{}", '{"address":"t9"}'] });
  const { result, lines } = await open(root, f.hc);
  assert.equal(result, undefined);
  assert.equal(f.runs().length, 1);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^Could not open the status view in herdr-core \(hc run gave no address: \{\}\)\.$/);
});

test("a run that answers with output that is not JSON is not retried", async () => {
  const root = setUp();
  const f = fake({ get: () => failure("not found"), runs: ["started", '{"address":"t9"}'] });
  const { result, lines } = await open(root, f.hc);
  assert.equal(result, undefined);
  assert.equal(f.runs().length, 1);
  assert.match(lines.join("\n"), /^Could not open the status view in herdr-core/);
});

test("a run that succeeds is made once, named, with no line", async () => {
  const root = setUp();
  const f = fake({ get: () => failure("not found"), runs: ['{"address":"t9"}'] });
  const { result, lines } = await open(root, f.hc);
  assert.equal(result, "t9");
  assert.equal(f.runs().length, 1);
  assert.ok(f.runs()[0].includes("--name"));
  assert.deepEqual(lines, []);
});
