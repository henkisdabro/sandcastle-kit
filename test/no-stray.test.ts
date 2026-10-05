// A passing test file that prints outside `quietly` fails under the suite's preload
// (test/no-stray.ts), so a gate log stays free of stray lines. Each case runs one made-up test file
// the way package.json's `test` script runs the real ones.
//
//   pnpm exec tsx --test test/no-stray.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT, runNode } from "./cli-spawn.ts";

const dir = mkdtempSync(join(tmpdir(), "sandcastle-no-stray-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const quietPath = JSON.stringify(join(KIT, "test/quiet.ts"));

const run = (name: string, body: string) => {
  const file = join(dir, `${name}.test.ts`);
  writeFileSync(file, `import { test } from "node:test";\nimport { quietly } from ${quietPath};\ntest("passes", async () => {\n${body}\n});\n`);
  // Inside a test run, NODE_TEST_CONTEXT makes a nested run hand its output to the parent; drop it so
  // the child runs as the suite's own runner does.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return runNode(["--import", join(KIT, "test/no-stray.ts"), "--test", "--test-reporter=spec", file], { cwd: dir, env, encoding: "utf8", timeoutMs: 120_000 });
};

test("a test file that prints with console.log fails, naming the line", () => {
  const r = run("stdout", 'console.log("a stray line");');
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /wrote 1 line\(s\) outside quietly\(\)[^]*"a stray line"/);
});

test("a test file that prints to stderr fails", () => {
  const r = run("stderr", 'process.stderr.write("a stray warning\\n");');
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /stderr: "a stray warning"/);
});

test("a child's stderr that execFileSync passes on fails the file", () => {
  const r = run("child", 'const { execFileSync } = await import("node:child_process");\nexecFileSync(process.execPath, ["-e", "console.error(\\"child said\\")"]);');
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /stderr: "child said"/);
});

test("a test file that prints inside quietly passes, with the line in hand", () => {
  const r = run("quiet", 'const { lines } = await quietly(() => console.log("held"));\nif (lines.join() !== "held") throw new Error("not captured");');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /held|no-stray/);
});

test("a test file that prints nothing passes", () => {
  const r = run("clean", "");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("both test scripts in package.json preload the guard", () => {
  const { scripts } = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const name of ["test", "test:shard"]) assert.match(scripts[name]!, /--import \.\/test\/no-stray\.ts --test /, name);
});

test("test/full-check.sh's shards preload the guard as pnpm test does", () => {
  assert.match(readFileSync(join(KIT, "test/run-shards.sh"), "utf8"), /tsx --import \.\/test\/no-stray\.ts --test /);
});
