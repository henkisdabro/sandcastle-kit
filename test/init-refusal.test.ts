// `sandcastle init`'s refusal when a config exists: it says how to start over
// or update, and writes nothing before refusing. A throwaway repo, so no Docker
// and no network. (test/init.test.ts covers stack detection and scaffolding.)
//
//   node --test test/init-refusal.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing init.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { init } = await import("../src/init.ts");

test("an existing config is refused with the way forward, and nothing is written", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(join(root, ".sandcastle"));
  const sentinel = "// sentinel þ config\n";
  writeFileSync(join(root, ".sandcastle/config.ts"), sentinel);

  assert.throws(
    () => init(root),
    (err: Error) => /already exists\. To start over, move it aside/.test(err.message) && /\/sandcastle update/.test(err.message),
  );
  assert.equal(readFileSync(join(root, ".sandcastle/config.ts"), "utf8"), sentinel);
  assert.equal(existsSync(join(root, ".sandcastle/rules.md")), false);
  assert.equal(existsSync(join(root, ".sandcastle/.gitignore")), false);
});
