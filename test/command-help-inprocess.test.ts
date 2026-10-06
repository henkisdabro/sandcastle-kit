// Every command given `--help` or `-h` asks for help and gets its own entry. Checked in process:
// spawning the CLI once per command and flag cost a third of the test gate, each spawn starting
// node. test/command-help.test.ts keeps the spawned tests that show nothing runs.
//
//   node --test test/command-help-inprocess.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP, helpFor, wantsHelp } from "../src/help.ts";

// The commands the help text lists: each entry starts two spaces in, with the command's name
// (a flag like `--version` is not a command; `queue` has two entries).
const listed = [...new Set(HELP.flatMap((l) => /^ {2}([a-z][a-z-]*)/.exec(l)?.[1] ?? []))];
// `lean-apply` is internal and unlisted, so it gets the whole text.
const COMMANDS = [...listed, "lean-apply"];

test("the help lists the commands the CLI has", () => {
  for (const command of ["setup", "doctor", "run", "wait", "stop", "report", "status", "build", "preflight", "queue", "requeue", "blockers", "gates", "land", "preview", "lean", "init", "updated", "clean", "herdr"]) {
    assert.ok(listed.includes(command), `${command} is in the help`);
  }
});

for (const flag of ["--help", "-h"]) {
  test(`every command given ${flag} wants help and gets its own entry`, () => {
    for (const command of COMMANDS) {
      assert.ok(wantsHelp([command, flag]), `${command} ${flag} asks for help`);
      const help = helpFor(command);
      if (command === "lean-apply") assert.equal(help, HELP.join("\n"), "the whole text");
      else {
        assert.match(help, new RegExp(`^ {2}${command}( |$)`, "m"), `${command} ${flag} prints its entry`);
        assert.ok(help.split("\n").length < HELP.length, `${command}: its entry, not the whole text`);
      }
    }
  });
}

test("no help flag, no help", () => {
  assert.ok(!wantsHelp(["run", "170", "--note", "help"]));
  assert.ok(!wantsHelp([]));
});
