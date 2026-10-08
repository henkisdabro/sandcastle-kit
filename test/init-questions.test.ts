// The three questions `sandcastle init` leaves for rules.md (generated files, paths never to
// touch, the drift gate): the scaffolding that names them, the commented `generated` example,
// the closing message, and the skill's init step that asks them without gaining a numbered step
// (update.md refers to steps 4 and 6 by number). Temp dirs only: no Docker, no model, no network.
//
//   pnpm test:file test/init-questions.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Importing init.ts must not read the real user config.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));

const { init } = await import("../src/init.ts");
const { importConfig } = await import("../src/config.ts");

const kit = join(dirname(fileURLToPath(import.meta.url)), "..");
// Normalise line endings so the test reads the same checked out on either platform.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

// An npm package.json without a lockfile: init never asks the host's pnpm anything.
const project = (t: import("node:test").TestContext) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => void logs.push(args.join(" ")));
  const root = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }));
  init(root);
  return { root, logs: logs.join("\n") };
};

test("rules.md names the three questions and stays one HTML comment", (t) => {
  const { root } = project(t);
  const rules = read(join(root, ".sandcastle/rules.md")).trim();
  for (const word of ["Generated files", "Do not touch", "Drift"]) assert.ok(rules.includes(word), word);
  assert.ok(rules.startsWith("<!--"));
  assert.ok(rules.endsWith("-->"));
  assert.equal(rules.indexOf("-->"), rules.length - 3, "no other -->");
});

test("config.ts holds the commented generated example and no generated key", async (t) => {
  const { root } = project(t);
  const path = join(root, ".sandcastle/config.ts");
  assert.ok(read(path).includes("// generated: [{ paths:"));
  const config = await importConfig(path);
  assert.ok(!("generated" in config));
});

test("init prints the pointer to the three questions", (t) => {
  const { logs } = project(t);
  assert.ok(logs.includes("answer the three questions in .sandcastle/rules.md"));
});

const initSection = read(join(kit, "skill/init.md"));

test("init.md asks the questions and keeps its eight numbered steps", () => {
  assert.ok(initSection.length > 0, "init section not found");
  const flat = initSection.replace(/\s+/g, " ");
  for (const word of ["generated", "protectedPaths", "A gate for generated files", "question tool"]) {
    assert.ok(flat.includes(word), word);
  }
  assert.equal(initSection.match(/^\d+\. /gm)?.length, 8);
});

test("update.md still points at init steps 4 and 6", () => {
  const update = read(join(kit, "skill/update.md"));
  assert.match(update, /as in init\.md step 4/);
  assert.match(update, /as in init\.md step 6/);
});
