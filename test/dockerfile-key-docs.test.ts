// A Dockerfile written by hand is never built until the config names it, so every place the docs
// send a person or agent to write `.sandcastle/Dockerfile` says to add the key beside it.
//
//   pnpm test:file test/dockerfile-key-docs.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const KEY = 'dockerfile: ".sandcastle/Dockerfile"';
const read = (path: string) => readFileSync(join(root, path), "utf8");

// The text from `from` up to the next `to` (or the end), so the key must sit in that step.
function between(text: string, from: string, to?: string): string {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = to === undefined ? -1 : text.indexOf(to, start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

test("README setup step 3 names the dockerfile key beside the template", () => {
  const step = between(read("README.md"), "3. **`.sandcastle/Dockerfile`**", "4. **Lean and hooks**");
  assert.match(step, /templates\/Dockerfile/);
  assert.ok(step.includes(KEY), "README step 3 lacks the key");
});

test("skill init step 2 names the dockerfile key beside the template", () => {
  const step = between(read("skill/init.md"), "Extend\n   the Dockerfile", "3. **Make the sandbox lean.**");
  assert.match(step, /templates\/Dockerfile/);
  assert.ok(step.includes(KEY), "init.md step 2 lacks the key");
});

test("skill update hook step names the dockerfile key beside the Dockerfile", () => {
  const step = between(read("skill/update.md"), "Fix a `HOOK FAIL`", "2. **Config.**");
  assert.match(step, /\.sandcastle\/Dockerfile/);
  assert.ok(step.includes(KEY), "update.md hook step lacks the key");
});
