// A test missing from a clipped red output is not green: `runGates` reads the failing tests from the gate's whole
// output, before `clip`, and `flakedTests` and `disjointReds` never judge from a clipped one. No Docker, model or network.
//
//   pnpm test:file test/flaked-whole-output.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The machine-wide slots and the sandbox's directories derive from these at import.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const xdg = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
writeFileSync(join(xdg, "sandcastle-kit", ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\nGH_TOKEN=github_pat_fake\n");
const { runGates, flakedTests, disjointReds, wholeTests } = await import("../src/gates.ts");
const { dockerOptions, EXEC_TAIL_CHARS } = await import("../src/sandbox.ts");
const { fakeTracker } = await import("./fixtures.ts");
type Failure = import("../src/gates.ts").Failure;

const project = { name: "fixture", gates: [{ name: "test", command: "run-tests" }] } as Parameters<typeof runGates>[0];
const sandbox = (stdout: string, stderr = "") => ({ exec: async () => ({ exitCode: 1, stdout, stderr }) });

const FILLER = "x".repeat(99);
const filler = (lines: number) => Array.from({ length: lines }, () => FILLER);
const failing = (id: string) => `not ok 1 - ${id}`;
const redOf = async (stdout: string, stderr = "") => (await runGates(project, sandbox(stdout, stderr), "fixture gates")).failure as Failure;

test("a red gate's failing test that only the middle of a long output names is kept, though the output is clipped", async () => {
  const out = [...filler(400), failing("suite::middle"), ...filler(400)].join("\n");
  assert.ok(out.length > 32_000);
  const f = await redOf(out);
  assert.match(f.output, /\[\.\.\. \d+ characters cut \.\.\.\]/);
  assert.ok(!f.output.includes("suite::middle"));
  assert.deepEqual(f.tests, ["suite::middle"]);
});

test("a stream longer than half the exec tail leaves the failing tests unset", async () => {
  const big = "y".repeat(EXEC_TAIL_CHARS / 2 + 1);
  assert.equal((await redOf(`${failing("a")}\n${big}`)).tests, undefined);
  assert.equal((await redOf(failing("a"), big)).tests, undefined);
  assert.deepEqual((await redOf(`${failing("a")}\n${"y".repeat(1000)}`)).tests, ["a"]);
});

test("every sandbox is given the exec tail cap", () => {
  const options = dockerOptions({ root: mkdtempSync(join(tmpdir(), "sandcastle-test-")), tracker: fakeTracker(), mounts: [], cpus: false } as unknown as Parameters<typeof dockerOptions>[0], "image:tag");
  assert.equal(options.maxOutputTailChars, EXEC_TAIL_CHARS);
  assert.equal(EXEC_TAIL_CHARS, 8 * 1024 * 1024);
  assert.equal(options.imageName, "image:tag");
});

const fail = (output: string, tests?: string[]): Failure => ({ name: "test", command: "run-tests", exitCode: 1, output, ...(tests ? { tests } : {}) });
const CLIP = "[... 5000 characters cut ...]";

test("flakedTests and disjointReds use the whole-output tests of a clipped red", () => {
  const a = fail(`${failing("other")}\n${CLIP}`, ["alpha", "shared"]);
  const b = fail(`${failing("other")}\n${CLIP}`, ["beta", "shared"]);
  assert.deepEqual(flakedTests([a, b], true), ["alpha", "beta", "shared"]);
  assert.deepEqual(flakedTests([a, b], false), ["alpha"]);
  assert.equal(disjointReds(a, b), false);
  assert.equal(disjointReds(fail(CLIP, ["alpha"]), fail(CLIP, ["beta"])), true);
});

test("flakedTests and disjointReds read nothing from a clipped output with no whole-output tests", () => {
  const a = fail(`${failing("alpha")}\n${CLIP}`);
  const b = fail(`${failing("beta")}\n${CLIP}`);
  assert.deepEqual(wholeTests(a), []);
  assert.deepEqual(flakedTests([a, b], true), []);
  assert.equal(disjointReds(a, b), false);
});

test("flakedTests and disjointReds read an unclipped output with no whole-output tests as before", () => {
  const a = fail(failing("alpha"));
  const b = fail(failing("beta"));
  assert.deepEqual(wholeTests(a), ["alpha"]);
  assert.deepEqual(flakedTests([a, b], true), ["alpha", "beta"]);
  assert.equal(disjointReds(a, b), true);
});
