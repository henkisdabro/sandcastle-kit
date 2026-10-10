// The `keepWarm` run setting: on by default, off per project, off per person on their machine,
// refused when it is not a boolean, and always in the settings group a turn's run record carries.
// No Docker, no model calls.
//
//   pnpm test:file test/keep-warm-setting.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { resolveSettings, settingsGroup } = await import("../src/run-settings.ts");
const { loadProject } = await import("../src/config.ts");
const { machineSettings } = await import("../src/sandbox.ts");

const resolve = (project: { keepWarm?: unknown }, machine: Record<string, unknown> = {}) => resolveSettings({ env: {}, project, machine });

test("a run keeps its session's cache warm unless a project or the person turned it off", () => {
  const table: [string, { keepWarm?: unknown }, Record<string, unknown>, boolean][] = [
    ["nothing set", {}, {}, true],
    ["project true", { keepWarm: true }, {}, true],
    ["project false", { keepWarm: false }, {}, false],
    ["machine false over project true", { keepWarm: true }, { keepWarm: false }, false],
    ["machine false over nothing", {}, { keepWarm: false }, false],
    ["machine true does not override a project false", { keepWarm: false }, { keepWarm: true }, false],
  ];
  for (const [name, project, machine, want] of table) assert.equal(resolve(project, machine).keepWarm, want, name);
});

test("the settings group carries keepWarm whether it is true or false", () => {
  assert.equal(settingsGroup(resolve({}), 1).keepWarm, true);
  const off = settingsGroup(resolve({ keepWarm: false }), 1);
  assert.ok("keepWarm" in off);
  assert.equal(off.keepWarm, false);
});

test("a project's keepWarm that is not true or false is refused, naming the key and the value", async () => {
  // One project root per value: the config module is cached by path.
  const project = (keepWarm: string) => {
    const root = mkdtempSync(join(tmpdir(), "sandcastle-keep-warm-"));
    mkdirSync(join(root, ".sandcastle"));
    writeFileSync(join(root, ".sandcastle", "config.ts"), `export default { name: "demo", keepWarm: ${keepWarm}, gates: [{ name: "t", command: "true" }] };\n`);
    return root;
  };
  await assert.rejects(() => loadProject(project('"no"')), /`keepWarm` must be true or false, not "no"/);
  await assert.rejects(() => loadProject(project("0")), /`keepWarm` must be true or false, not 0/);
  assert.equal((await loadProject(project("false"))).keepWarm, false);
});

test("the personal config.json may hold keepWarm", () => {
  const dir = join(process.env.XDG_CONFIG_HOME as string, "sandcastle-kit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), '{"keepWarm": false}');
  assert.equal(machineSettings().keepWarm, false);
});
