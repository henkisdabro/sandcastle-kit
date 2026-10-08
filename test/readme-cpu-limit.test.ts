// The README's paragraph on the sandbox CPU limit says it is a time quota, not pinned cores, which
// CPU counts inside a sandbox see it (`os.availableParallelism()`) and which count the VM's CPUs
// (`nproc`, `os.cpus()`, Python's `os.cpu_count()`), and what to give a runner that sizes from those.
//
//   pnpm test:file test/readme-cpu-limit.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
const paragraphs = readme.split(/\n\s*\n/).filter((p) => !p.startsWith("|")).map((p) => p.replace(/\s+/g, " "));
const row = readme.split("\n").find((line) => line.startsWith("| `cpus` |"));

test("README's CPU-limit paragraph says which CPU counts see the limit", () => {
  const paragraph = paragraphs.find((p) => p.includes("`docker run --cpus`") && p.includes("os.availableParallelism()"));
  assert.ok(paragraph, "a paragraph should document the CPU limit with os.availableParallelism()");
  assert.match(paragraph, /time quota.*not a set of pinned cores/);
  assert.match(paragraph, /`nproc`/);
  assert.match(paragraph, /os\.cpus\(\)/);
  assert.match(paragraph, /os\.cpu_count\(\)/);
  assert.match(paragraph, /pytest -n <N>/);
  assert.match(paragraph, /make -j<N>/);
});

test("README's cpus row says the limit is a time quota, not pinned cores", () => {
  assert.ok(row, "the settings table should have a cpus row");
  assert.match(row, /time quota, not pinned cores/);
  assert.match(row, /os\.availableParallelism\(\)/);
  assert.match(row, /`nproc`/);
  assert.match(row, /pytest -n <N>/);
});
