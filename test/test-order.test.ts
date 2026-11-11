// `pnpm test` starts the test files heaviest first, in the order `TEST_SHARD=1/1 node test/shard.ts`
// prints, not the glob's alphabet.
//
//   pnpm test:file test/test-order.test.ts

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT, runKit } from "./cli-spawn.ts";

const script = join(KIT, "test/shard.ts");
const all = readdirSync(join(KIT, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`).sort();
const weights = [...readFileSync(script, "utf8").matchAll(/^ {2}"(test\/[^"]+)": (\d+),$/gm)].map((m) => ({ file: m[1]!, weight: Number(m[2]) }));

test("the single shard lists every test file once, the weighted ones first and heaviest first", () => {
  const r = runKit([], { script, cwd: KIT, env: { ...process.env, TEST_SHARD: "1/1" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const order = r.stdout.trim().split("\n");
  assert.deepEqual([...order].sort(), all);
  assert.ok(weights.length > 1, "shard.ts has a WEIGHTS table");
  const expected = [...weights].sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file)).map((w) => w.file);
  assert.deepEqual(order.slice(0, expected.length), expected);
});

test("pnpm test takes its file list from the single shard and no longer names the glob", () => {
  const cmd: string = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).scripts.test;
  assert.match(cmd, /files=\$\(TEST_SHARD=1\/1 node test\/shard\.ts\) && /);
  assert.match(cmd, /\[ -n "\$files" \]/);
  assert.match(cmd, / --test .*\$files'$/);
  assert.ok(!cmd.includes("test/*.test.ts"), cmd);
});
