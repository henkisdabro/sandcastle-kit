// `sandcastle doctor`'s machine-wide settings check on the mod's `idleMark` switch: false (and
// true) pass, any other value is reported with its fix. The mod only reads the file, so doctor is
// where a typo is told. No Docker, no network.
//
//   pnpm exec tsx --test test/doctor-idle-mark.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), "sandcastle-idle-mark-"));

// This node and tsx directly, never bin/sandcastle: see test/settings.test.ts.
const doctor = (settings: string | undefined) => {
  const config = temp();
  if (settings !== undefined) {
    mkdirSync(join(config, "sandcastle-kit"));
    writeFileSync(join(config, "sandcastle-kit", "config.json"), settings);
  }
  const r = spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), "doctor"], {
    cwd: temp(),
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: temp(), CLAUDE_CODE_VERSION: "2.1.0", CODEX_VERSION: "0.1.0" },
  });
  const out = r.stdout + r.stderr;
  return out.split("\n").filter((l) => l.includes("machine-wide settings") || l.includes("idleMark")).join("\n");
};

test('"idleMark": false, true and no value pass', () => {
  for (const settings of ['{"idleMark": false}', '{"idleMark": true, "maxGates": 2}', "{}", undefined]) {
    assert.match(doctor(settings), /^ok +machine-wide settings/, String(settings));
  }
});

test("an idleMark that is not a boolean is reported with its fix", () => {
  for (const value of ['"false"', "0", "null", '"no"']) {
    const out = doctor(`{"idleMark": ${value}}`);
    assert.match(out, /^FIX +machine-wide settings/, value);
    assert.ok(out.includes(`"idleMark" in `) && out.includes(`is ${value}, not true or false.`), out);
    assert.match(out, /Set it to `false` to turn the Claude Code mod's idle mark off, or delete the line to show it\./);
  }
});
