// update.md tells the operator to update projects that need an image rebuild one at a time, and why:
// image builds are serialised machine-wide (`BASE_LOCK`), so parallel updates only queue and can push
// container starts past the 120 s limit (#647).
//
//   pnpm test:file test/skill-update-one-project.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");

test("the update action says to update several projects one at a time, and why", () => {
  const text = flat(read("skill", "update.md"));
  assert.match(text, /several projects[^.]*update them one at a time/);
  assert.match(text, /serialised machine-wide/);
  assert.match(text, /120 s limit/);
});

test("the claim holds: the image build takes a machine-wide lock", () => {
  assert.match(read("src", "sandbox.ts"), /export const BASE_LOCK = /);
});
