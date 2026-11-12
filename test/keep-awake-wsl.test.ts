// Keep awake under WSL: Windows decides when the PC sleeps, so the Linux helper is never tried
// there; a helper that fails says why, and the answer is remembered so a later turn does not probe
// and start it again. Shims named systemd-inhibit and caffeinate log `probe` (called with -h) or
// `run` to a count file. Paths come from node:path and os.tmpdir(); the shims are POSIX sh.
//
//   pnpm test:file test/keep-awake-wsl.test.ts

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { isWsl, keepAwake, resetKeepAwake } = await import("../src/run.ts");

const cmd = process.platform === "darwin" ? "caffeinate" : "systemd-inhibit";
const WSL_LINE = "off - under WSL, Windows decides when the PC sleeps: keep it awake in Windows' power settings";

test("WSL is told by the distro name or by Microsoft in the kernel release, on Linux only", () => {
  assert.equal(isWsl("linux", { WSL_DISTRO_NAME: "Ubuntu" }, () => "6.1.0"), true);
  assert.equal(isWsl("linux", {}, () => "6.18.58.1-microsoft-standard-WSL2"), true);
  assert.equal(isWsl("linux", {}, () => "5.15.0-Microsoft"), true);
  assert.equal(isWsl("linux", {}, () => "6.1.0-generic"), false);
  assert.equal(isWsl("linux", { WSL_DISTRO_NAME: "" }, () => "6.1.0-generic"), false);
  assert.equal(isWsl("darwin", { WSL_DISTRO_NAME: "x" }, () => "microsoft"), false);
});

// Runs `fn` with shims on PATH that log each call; returns the count file's lines afterwards.
const withShims = async (body: string, fn: () => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const bin = join(dir, "bin");
  const counts = join(dir, "counts");
  mkdirSync(bin);
  for (const name of ["caffeinate", "systemd-inhibit"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nif [ "$1" = "-h" ]; then echo probe >> '${counts}'; exit 0; fi\necho run >> '${counts}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const saved = { PATH: process.env.PATH, KEEP_AWAKE: process.env.KEEP_AWAKE };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.KEEP_AWAKE = "1";
  resetKeepAwake();
  try {
    await fn();
  } finally {
    resetKeepAwake();
    process.env.PATH = saved.PATH;
    if (saved.KEEP_AWAKE === undefined) delete process.env.KEEP_AWAKE;
    else process.env.KEEP_AWAKE = saved.KEEP_AWAKE;
  }
  return existsSync(counts) ? readFileSync(counts, "utf8").split("\n").filter(Boolean) : [];
};

test("under WSL the line says Windows decides sleep, and no helper is probed or run", async () => {
  const calls = await withShims("exit 1", async () => {
    assert.equal(await keepAwake({ wsl: true }), WSL_LINE);
  });
  assert.deepEqual(calls, []);
});

test("a helper that fails gives its first stderr line, and the next turn does not try it again", async () => {
  const calls = await withShims('echo "Failed to inhibit: Access denied" >&2; echo "second line" >&2; exit 1', async () => {
    const line = `off - ${cmd} failed: Failed to inhibit: Access denied`;
    assert.equal(await keepAwake({ wsl: false }), line);
    assert.equal(await keepAwake({ wsl: false }), line);
  });
  assert.deepEqual(calls, ["probe", "run"]);
});

test("a helper that fails with no stderr says only that it failed", async () => {
  await withShims("exit 1", async () => {
    assert.equal(await keepAwake({ wsl: false }), `off - ${cmd} failed`);
  });
});

test("KEEP_AWAKE=0 comes before WSL: the operator's choice is the line", async () => {
  const saved = process.env.KEEP_AWAKE;
  process.env.KEEP_AWAKE = "0";
  resetKeepAwake();
  try {
    assert.equal(await keepAwake({ wsl: true }), "off - the machine's energy settings apply");
  } finally {
    if (saved === undefined) delete process.env.KEEP_AWAKE;
    else process.env.KEEP_AWAKE = saved;
  }
});
