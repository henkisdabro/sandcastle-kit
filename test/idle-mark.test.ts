// The idle mark's decisions (mod/hooks/idle.ts), pure: the line between runs in a set-up project,
// and the machine switch read from the personal settings. No Claude Code needed; the hooks that
// draw it are tested in mod/tests/.
//
//   node --test test/idle-mark.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { machineSwitch, markText, SETTINGS_SCRIPT } from "../mod/hooks/idle.ts";

test("markText: set up gives the bare mark; not set up, and the machine switch off, clear it", () => {
  const table: [{ setUp: boolean; idleMark: boolean }, string | undefined][] = [
    [{ setUp: true, idleMark: true }, "sandcastle"],
    [{ setUp: false, idleMark: true }, undefined],
    [{ setUp: true, idleMark: false }, undefined],
    [{ setUp: false, idleMark: false }, undefined],
  ];
  for (const [input, text] of table) assert.equal(markText(input), text, JSON.stringify(input));
});

test("machineSwitch: off only for idleMark false; a file it cannot use leaves the mark on", () => {
  const table: [string, boolean][] = [
    ['{"idleMark": false}', false],
    ['{"idleMark": false, "maxGates": 2}', false],
    ['{"idleMark": true}', true],
    ["{}", true],
    ["", true],
    ["{ not json", true],
    ["null", true],
    ["[false]", true],
    ['{"idleMark": "false"}', true],
    ['{"idleMark": 0}', true],
  ];
  for (const [text, on] of table) assert.equal(machineSwitch(text), on, JSON.stringify(text));
});

test("the settings script reads the file the kit does: XDG_CONFIG_HOME, else ~/.config", () => {
  assert.ok(SETTINGS_SCRIPT.includes("${XDG_CONFIG_HOME:-$HOME/.config}/sandcastle-kit/config.json"));
});
