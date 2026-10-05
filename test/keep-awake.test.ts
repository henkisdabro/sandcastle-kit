// The start line's "Keep awake:" says on only while the inhibitor is really holding the machine
// awake. With systemd installed but no system bus (WSL without systemd, a container),
// `systemd-inhibit -h` exits 0 while the real call fails at once, so a probe alone reported on.
//
// Shim inhibitors on PATH, under both names (caffeinate on macOS, systemd-inhibit elsewhere), so
// the same test holds on either platform. `-h` succeeds in both, as the real tool's does. Paths
// come from node:path and os.tmpdir(); the shims are POSIX sh.
//
//   pnpm exec tsx --test test/keep-awake.test.ts

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { keepAwake } = await import("../src/run.ts");

const cmd = process.platform === "darwin" ? "caffeinate" : "systemd-inhibit";

const withShim = async (body: string) => {
  const bin = join(mkdtempSync(join(tmpdir(), "sandcastle-test-")), "bin");
  mkdirSync(bin);
  for (const name of ["caffeinate", "systemd-inhibit"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n[ "$1" = "-h" ] && exit 0\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const saved = { PATH: process.env.PATH, KEEP_AWAKE: process.env.KEEP_AWAKE };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.KEEP_AWAKE = "1";
  try {
    return await keepAwake();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.KEEP_AWAKE === undefined) delete process.env.KEEP_AWAKE;
    else process.env.KEEP_AWAKE = saved.KEEP_AWAKE;
  }
};

test("an inhibitor that fails at once is reported off, not on", async () => {
  assert.equal(await withShim('echo "Failed to connect to system scope bus" >&2; exit 1'), `off - ${cmd} failed`);
});

test("an inhibitor that keeps running is reported on", async () => {
  // Ends with the test process, as the real inhibitor ends with the run's.
  assert.equal(await withShim('while kill -0 "$PPID" 2>/dev/null; do sleep 1; done'), `on (${cmd})`);
});

test("no inhibitor on PATH is reported off - not found", async () => {
  const saved = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  process.env.KEEP_AWAKE = "1";
  try {
    assert.equal(await keepAwake(), `off - ${cmd} not found`);
  } finally {
    process.env.PATH = saved;
  }
});
