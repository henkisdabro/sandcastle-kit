// CI's shards (test/shard.ts) run every test file exactly once, and spread the slow ones.
//
//   pnpm exec tsx --test test/shard.test.ts

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT, runKit } from "./cli-spawn.ts";

const script = join(KIT, "test/shard.ts");
const shard = (spec: string) => runKit([], { script, cwd: KIT, env: { ...process.env, TEST_SHARD: spec }, encoding: "utf8" });
const all = readdirSync(join(KIT, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`).sort();

test("four shards hold every test file once between them, the two slowest apart", () => {
  const parts = [1, 2, 3, 4].map((i) => {
    const r = shard(`${i}/4`);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split("\n");
  });
  assert.deepEqual(parts.flat().sort(), all);
  const holding = (file: string) => parts.findIndex((p) => p.includes(file));
  assert.notEqual(holding("test/quiet-output.test.ts"), holding("test/detach.test.ts"));
});

test("a TEST_SHARD that is not i/n is refused", () => {
  for (const spec of ["", "5/4", "0/4", "two/4"]) assert.notEqual(shard(spec).status, 0, spec);
});
