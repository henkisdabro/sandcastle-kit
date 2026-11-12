// A pause may end an inhibitor during its initial settle. That intentional stop must not be
// remembered as a helper failure: the next resume still has to hold the machine awake.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { keepAwake, holdAwake, releaseAwake, resetKeepAwake } = await import("../src/run.ts");

test("a pause during the helper's settle does not stop the next resume keeping awake", async () => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const counts = join(bin, "counts");
  for (const name of ["caffeinate", "systemd-inhibit"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n[ "$1" = "-h" ] && exit 0\necho run >> '${counts}'\nexec sleep 30\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const saved = { PATH: process.env.PATH, KEEP_AWAKE: process.env.KEEP_AWAKE };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.KEEP_AWAKE = "1";
  resetKeepAwake();
  try {
    const starting = keepAwake({ wsl: false });
    const deadline = Date.now() + 2000;
    while (!existsSync(counts) && Date.now() < deadline) await delay(5);
    assert.ok(existsSync(counts), "the helper has started");
    releaseAwake();
    await starting;
    await holdAwake({ wsl: false });
    assert.deepEqual(readFileSync(counts, "utf8").trim().split("\n"), ["run", "run"], "resume starts a new helper after the pause stopped the settling one");
    assert.match(await keepAwake({ wsl: false }), /^on \(/);
  } finally {
    releaseAwake();
    resetKeepAwake();
    process.env.PATH = saved.PATH;
    if (saved.KEEP_AWAKE === undefined) delete process.env.KEEP_AWAKE;
    else process.env.KEEP_AWAKE = saved.KEEP_AWAKE;
  }
});
