// `sandcastle <command> --help` prints every entry the help text has for that command, not only
// the first: `queue --help` that left out `queue --lint` hid half of the command.
//
//   node --test test/command-help-entries.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { helpFor } from "../src/help.ts";

test("a command with two entries gets both", () => {
  const help = helpFor("queue");
  assert.match(help, /^ {2}queue \[--json\]/m);
  assert.match(help, /^ {2}queue --lint/m);
  assert.ok(!help.includes("requeue"), "only the command's own entries");
});
