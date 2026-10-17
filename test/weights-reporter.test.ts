// test/weights-reporter.ts, the reporter CI's shards and `pnpm test:weights` run: over a made-up
// suite, it prints each file's top-level test durations summed. And test/weights.ts, which turns
// such readings into test/shard.ts's WEIGHTS table, the files under 2.5 s left out.
//
//   pnpm test:file test/weights-reporter.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT, runNode } from "./cli-spawn.ts";
import { merge, type Reading, weightsBlock, withWeights } from "./weights.ts";

const root = mkdtempSync(join(tmpdir(), "weights-reporter-"));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "test"));

// Each top-level test waits the given milliseconds inside a nested test: the nested test's time is
// already part of its parent's, so a reporter that counted it too would double the file.
const fixture = (name: string, ...waits: number[]) =>
  writeFileSync(
    join(root, "test", name),
    `import { test } from "node:test";\n` +
      waits.map((ms, i) => `test("t${i}", async (t) => { await t.test("inner", () => new Promise((r) => setTimeout(r, ${ms}))); });\n`).join(""),
  );
fixture("slow.test.ts", 900, 900, 900, 900);
fixture("fast.test.ts", 50);
writeFileSync(join(root, "test", "failing.test.ts"), `import { test } from "node:test";\ntest("slow and red", async () => { await new Promise((r) => setTimeout(r, 2600)); throw new Error("red"); });\n`);

test("it prints one JSON reading: the platform, and each file's top-level test durations summed", () => {
  const reporter = join(KIT, "test/weights-reporter.ts");
  const r = runNode(["--test", "--test-concurrency=3", `--test-reporter=${reporter}`, "test/slow.test.ts", "test/fast.test.ts", "test/failing.test.ts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(r.stderr.includes("Error"), false, r.stderr);
  const reading = JSON.parse(r.stdout) as Reading;
  assert.equal(reading.platform, process.platform);
  assert.deepEqual(Object.keys(reading.files).sort(), ["test/failing.test.ts", "test/fast.test.ts", "test/slow.test.ts"]);
  const seconds = (file: string) => Math.round(reading.files[file]! / 1000);
  assert.equal(seconds("test/slow.test.ts"), 4); // four tests of 0.9 s: 3.6 s, to the nearest second, and not 7
  assert.equal(seconds("test/failing.test.ts"), 3); // a failing test counts as much as a passing one
});

test("test/weights.ts takes each platform's mean, then the platforms' mean, and keeps the files at 2.5 s or more", () => {
  const block = weightsBlock(
    merge([
      { platform: "darwin", files: { "test/a.test.ts": 8000, "test/b.test.ts": 3000, "test/c.test.ts": 2000 } },
      { platform: "darwin", files: { "test/a.test.ts": 6000 } },
      { platform: "linux", files: { "test/a.test.ts": 3000, "test/b.test.ts": 3000, "test/c.test.ts": 2000, "test/d.test.ts": 3000 } },
    ]),
  );
  // a: darwin 7 s and linux 3 s; d ran on one platform only and keeps its one figure
  assert.equal(block, ["const WEIGHTS: Record<string, number> = {", '  "test/a.test.ts": 5,', '  "test/b.test.ts": 3,', '  "test/d.test.ts": 3,', "};"].join("\n"));
});

test("test/weights.ts --write replaces shard.ts's table, and the table it writes is one it can replace again", () => {
  const source = readFileSync(join(KIT, "test/shard.ts"), "utf8");
  const block = weightsBlock(new Map([["test/x.test.ts", 9000]]));
  const once = withWeights(source, block);
  assert.ok(once.includes(`${block}\n`), once);
  assert.equal(once.split("const WEIGHTS").length, 2);
  assert.equal(withWeights(once, block), once);
  assert.equal(once.slice(0, once.indexOf("const WEIGHTS")), source.slice(0, source.indexOf("const WEIGHTS")));
  assert.throws(() => withWeights("no table here", block), /no WEIGHTS table/);
});
