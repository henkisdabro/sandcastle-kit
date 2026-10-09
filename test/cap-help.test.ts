// `sandcastle help` and `sandcastle cap --help` cover the cap command: what it takes, that the run
// keeps its slots, that the cap ends with the run. Spawned outside any repository: help needs none.
//
//   pnpm test:file test/cap-help.test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const cli = (...args: string[]) => {
  const config = mkdtempSync(join(tmpdir(), "sandcastle-cap-help-cfg-"));
  const r = runKit(args, {
    cwd: mkdtempSync(join(tmpdir(), "sandcastle-cap-help-")),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: config, XDG_CONFIG_HOME: config, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("the help lists cap, and cap --help prints its entry alone", () => {
  assert.match(cli("help"), /^ {2}cap \[N \| off\] \[--project NAME\]/m);
  const entry = cli("cap", "--help");
  assert.match(entry, /^ {2}cap \[N \| off\] \[--project NAME\]/m);
  assert.match(entry, /concurrency/);
  assert.match(entry, /keeps the slots it holds/);
  assert.match(entry, /ends with\s+the run/);
  assert.match(entry, /--project/);
  assert.ok(!entry.includes("setup  "), "only the command's own entry");
  assert.ok(!entry.includes("stop  "), "only the command's own entry");
  for (const line of entry.split("\n")) assert.ok(line.length <= 90, `fits the terminal: ${line}`);
});
