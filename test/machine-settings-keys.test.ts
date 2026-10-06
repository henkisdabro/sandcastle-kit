// The personal config.json refuses an unknown key and names the nearest real one, as the
// project config does; doctor reports it, even where an environment variable sets the limits.
//
//   node --test test/machine-settings-keys.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runKit, runNode } from "./cli-spawn.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), "sandcastle-keys-"));
const configWith = (body: string) => {
  const config = temp();
  mkdirSync(join(config, "sandcastle-kit"));
  const file = join(config, "sandcastle-kit", "config.json");
  writeFileSync(file, body);
  return { config, file };
};

// Each case runs in a child process: the settings are read once per process.
const read = (config: string) =>
  runNode(["--input-type=module", "-e",
    `const { machineSettings } = await import("./src/sandbox.ts"); try { console.log(JSON.stringify(machineSettings())); } catch (e) { console.log(e.constructor.name, e.message); }`], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: temp(), XDG_CONFIG_HOME: config },
  }).stdout.trim();

test("a typo in a key is refused with the file and the nearest real key", () => {
  const { config, file } = configWith('{"keepawake": false}');
  assert.equal(read(config), `OperatorError ${file}: unknown key \`keepawake\` - did you mean \`keepAwake\`?`);
});

test("a key near none is refused and points at the README", () => {
  const { config, file } = configWith('{"colour": "red"}');
  assert.equal(read(config), `OperatorError ${file}: unknown key \`colour\` (README -> Personal settings lists the keys)`);
});

test("every documented key is accepted", () => {
  const body = { maxSandboxes: 4, maxGates: 1, keepAwake: false, notify: ["true"] };
  const { config } = configWith(JSON.stringify(body));
  assert.deepEqual(JSON.parse(read(config)), body);
});

test("doctor reports an unknown key as a FIX line, with the limits set in the environment", () => {
  const { config } = configWith('{"keepawake": false}');
  const r = runKit(["doctor"], {
    cwd: temp(),
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: temp(), SANDCASTLE_MAX_SANDBOXES: "3", SANDCASTLE_MAX_GATES: "1", CLAUDE_CODE_VERSION: "2.1.0", CODEX_VERSION: "0.1.0" },
  });
  assert.match(r.stdout, /FIX +machine-wide settings[\s\S]*unknown key `keepawake` - did you mean `keepAwake`\?/);
});
