// test/status.test.sh proves status.sh runs under macOS's bash 3.2 by rendering one scenario through it and
// comparing the frame with the one the file's own bash draws - not by running the whole file again under it,
// which made every gate render every scenario four times. Where this repository's image has bash32
// (/usr/local/bin/bash32) the comparison runs here for real, alone (STATUS_BASH32_ONLY=1 skips the rest).
//
//   pnpm test:file test/status-bash32-once.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT } from "./cli-spawn.ts";

const SCRIPT = join(KIT, "test/status.test.sh");
const BASH32 = "/usr/local/bin/bash32";
const source = readFileSync(SCRIPT, "utf8");

test("status.test.sh does not run itself again under bash32", () => {
  assert.doesNotMatch(source, /bash32[^\n]*"\$0"/);
  assert.doesNotMatch(source, /"\$0"[^\n]*bash32/);
  assert.doesNotMatch(source, /status view again under bash32/);
});

test("the bash32 comparison runs only with STATUS_BASH unset and 80 columns, where bash32 exists", () => {
  const guard = source.split("\n").find((l) => l.startsWith("bash32_applies()"));
  assert.ok(guard, "bash32_applies is defined");
  assert.match(guard, /-z "\$\{STATUS_BASH:-\}"/);
  assert.match(guard, /"\$COLS" = 80/);
  assert.match(guard, /-x "\$BASH32"/);
  assert.match(source, /^BASH32=\/usr\/local\/bin\/bash32$/m);
  assert.match(source, /^if bash32_applies; then bash32_same_frame /m);
  assert.match(source, /FAIL \[bash32\]/);
});

test("test/suite.sh and docs/layout.md say one scenario is rendered under bash32, and AGENTS.md claims no second pass", () => {
  const suite = readFileSync(join(KIT, "test/suite.sh"), "utf8");
  assert.doesNotMatch(suite, /each with its bash32 pass/);
  assert.match(suite, /one\s+# scenario under bash32|also renders\s+# one scenario under bash32/);
  for (const doc of ["AGENTS.md", "docs/layout.md"]) {
    const text = readFileSync(join(KIT, doc), "utf8");
    assert.doesNotMatch(text, /runs a second time under it/, doc);
    assert.doesNotMatch(text, /second pass under `bash32`/, doc);
  }
});

test("status.sh under bash32 draws the same frame as under the bash on PATH", { skip: existsSync(BASH32) ? false : `${BASH32} is absent (this repository's sandbox image builds it)` }, () => {
  const env: NodeJS.ProcessEnv = { ...process.env, STATUS_BASH32_ONLY: "1" };
  delete env.STATUS_BASH;
  delete env.COLS;
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 110_000 });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /^status view: status\.sh under bash32 drew the same frame$/m);
  assert.doesNotMatch(out, /FAIL \[/);
});
