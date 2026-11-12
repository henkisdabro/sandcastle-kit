// `pnpm test:related` on a central module is refused with 20 files and a count, not all of them (#945).
//
//   pnpm test:file test/related-refusal-short.test.ts

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KIT, runKit } from "./cli-spawn.ts";

test("a refusal lists the first 20 files and counts the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-related-short-"));
  mkdirSync(join(dir, "test"));
  copyFileSync(join(KIT, "test/related.ts"), join(dir, "test/related.ts"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/core.ts"), "export const coreThing = 1;\n");
  for (let i = 0; i < 41; i++) writeFileSync(join(dir, `test/t${String(i).padStart(2, "0")}.test.ts`), "coreThing;\n");
  const r = runKit(["src/core.ts"], { script: join(dir, "test/related.ts"), cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, "");
  const lines = r.stderr.split("\n");
  assert.match(lines[0], /^41 test files mention src\/core\.ts .*--all/);
  assert.equal(lines.filter((l) => /^\s+test\/\S+\.test\.ts$/.test(l)).length, 20);
  assert.ok(lines.includes("  ... and 21 more (--all runs them all)"), r.stderr);
});
