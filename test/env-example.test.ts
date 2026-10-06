// `.env.example` is what `sandcastle setup` and a by-hand install copy: its header must not promise
// that a project's .sandcastle/.env can override a key the kit refuses there.
//
//   node --test test/env-example.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { HOST_ONLY_KEYS } = await import("../src/sandbox.ts");

test("the header's override sentence names every host-only key as an exception", () => {
  const header = readFileSync(join(import.meta.dirname, "../.env.example"), "utf8").split("\n\n")[0].replace(/\n# /g, " ");
  const sentence = header.split(". ").find((s) => /override/.test(s));
  assert.ok(sentence, header);
  for (const key of HOST_ONLY_KEYS) assert.match(sentence, new RegExp(`but ${key}\\b`), sentence);
});
