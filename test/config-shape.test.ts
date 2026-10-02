// Mistakes in .sandcastle/config.ts are refused before anything runs, with the key and what it
// takes: a syntax error reached the operator as a loader stack trace, and an unknown key (a typo
// such as `concurency`) or a wrong type (`concurrency: "two"`) was ignored, so the run used a default.
//
//   pnpm exec tsx --test test/config-shape.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject } from "../src/config.ts";
import { OperatorError } from "../src/errors.ts";

const load = (body: string) => {
  const root = mkdtempSync(join(tmpdir(), "sc-config-"));
  mkdirSync(join(root, ".sandcastle"));
  writeFileSync(join(root, ".sandcastle/config.ts"), body);
  return loadProject(root);
};
const ok = 'name: "t", tracker: "files", gates: [{ name: "t", command: "true" }]';
const refused = async (extra: string, message: RegExp) => {
  await assert.rejects(load(`export default { ${ok}, ${extra} };\n`), (e: Error) => e instanceof OperatorError && message.test(e.message));
};

test("a syntax error is one line naming the place, not a stack trace", async () => {
  await assert.rejects(load("export default { gates: [ } };\n"), (e: Error) => e instanceof OperatorError && /^\.sandcastle\/config\.ts does not load: \.sandcastle\/config\.ts:1:\d+: ERROR/.test(e.message));
});

test("an unknown key is refused, with the nearest real one", async () => {
  await refused("concurency: 2", /unknown key `concurency` - did you mean `concurrency`\?/);
  await refused("repair: { attempt: 2 }", /unknown key `repair\.attempt` - did you mean `repair\.attempts`\?/);
  await refused("frobnicate: 1", /unknown key `frobnicate` \(README -> Configuration/);
});

test("wrong types are refused with what the key takes", async () => {
  await refused('concurrency: "two"', /`concurrency` must be a whole number of 1 or more, not "two"/);
  await refused("concurrency: 0", /`concurrency` must be a whole number of 1 or more, not 0/);
  await refused("repair: { attempts: -1 }", /`repair\.attempts` must be a whole number of 0 or more/);
  await refused('protectedPaths: ".github"', /`protectedPaths` must be a list of strings/);
  await refused("autonomy: 5", /`autonomy` must be 0, 1, 2, 3 or "drain"/);
  await refused('autonomy: "forever"', /`autonomy` must be 0, 1, 2, 3 or "drain", not "forever"/);
  await assert.rejects(load('export default { name: "t", gates: [{ name: "t" }] };\n'), /each gate needs a `name` and a `command`/);
  await assert.rejects(load('export default { name: "t", gates: [] };\n'), /at least one gate/);
});

test('autonomy: "drain" is accepted', async () => {
  assert.equal((await load(`export default { ${ok}, autonomy: "drain" };\n`)).autonomy, "drain");
});

test("a valid config, repair off included, loads", async () => {
  const p = await load(`export default { ${ok}, concurrency: 2, repair: { attempts: 0 }, protectedPaths: ["infra/"], lean: { keep: [], dropHooks: [] } };\n`);
  assert.equal(p.concurrency, 2);
  assert.equal(p.repair.attempts, 0);
});
