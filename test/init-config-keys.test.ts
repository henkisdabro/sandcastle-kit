// The config `sandcastle init` writes names every project config key, set or commented out: a key
// it leaves out is one a new project never learns exists (eight had fallen out of the template by
// 0.17.0). Keys the stack block writes count, from a no-stack project and a pnpm one.
//
//   pnpm test:file test/init-config-keys.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Importing init.ts must not read the real user config or take real cache slots.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { init } = await import("../src/init.ts");

const written = (t: { after: (fn: () => void) => void; mock: { method: Function } }, files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  t.mock.method(console, "log", () => {});
  init(root);
  return readFileSync(join(root, ".sandcastle/config.ts"), "utf8");
};

test("init's config names every ProjectConfig key, set or commented out", (t) => {
  const source = readFileSync(join(import.meta.dirname, "../src/config.ts"), "utf8");
  const type = source.slice(source.indexOf("export type ProjectConfig = {"));
  const keys = [...type.slice(0, type.indexOf("\n};")).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(keys.length > 20, `read only ${keys.length} keys from ProjectConfig`);

  const configs = [
    written(t, {}),
    written(t, { "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { test: "vitest" } }), "pnpm-lock.yaml": "" }),
  ].join("\n");
  const missing = keys.filter((key) => !new RegExp(`^\\s*(// )?${key}:`, "m").test(configs));
  assert.deepEqual(missing, [], "add each to templates/config.ts, commented out at its default or with an example");
});
