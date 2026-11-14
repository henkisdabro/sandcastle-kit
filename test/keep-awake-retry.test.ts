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

// The fake helper's line in `counts` is written by a shell that may start late on a loaded runner, so
// `keepAwake` returning "on" (the process stayed alive for the settle) does not mean the line is there yet.
// The test waits for the line it asserts on, not for the settle.
const linesIn = (counts: string): string[] => (existsSync(counts) ? readFileSync(counts, "utf8").trim().split("\n").filter(Boolean) : []);

const waitForLines = async (counts: string, n: number): Promise<string[]> => {
  const deadline = Date.now() + 5000;
  while (linesIn(counts).length < n && Date.now() < deadline) await delay(5);
  return linesIn(counts);
};

// `body` is the fake helper's shell, run after the `-h` probe; `counts` is the file its lines go to.
const pauseDuringSettle = async (body: (counts: string) => string) => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
  const counts = join(bin, "counts");
  for (const name of ["caffeinate", "systemd-inhibit"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n[ "$1" = "-h" ] && exit 0\n${body(counts)}\nexec sleep 30\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const saved = { PATH: process.env.PATH, KEEP_AWAKE: process.env.KEEP_AWAKE };
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.KEEP_AWAKE = "1";
  resetKeepAwake();
  try {
    const starting = keepAwake({ wsl: false });
    assert.equal((await waitForLines(counts, 1)).length, 1, "the first helper has started");
    releaseAwake();
    // Proves the release landed mid-settle: the first attempt was stopped, not settled.
    assert.match(await starting, /^off - /);
    await holdAwake({ wsl: false });
    assert.deepEqual(await waitForLines(counts, 2), ["run", "run"], "resume starts a new helper after the pause stopped the settling one");
    assert.match(await keepAwake({ wsl: false }), /^on \(/);
  } finally {
    releaseAwake();
    resetKeepAwake();
    process.env.PATH = saved.PATH;
    if (saved.KEEP_AWAKE === undefined) delete process.env.KEEP_AWAKE;
    else process.env.KEEP_AWAKE = saved.KEEP_AWAKE;
  }
};

test("a pause during the helper's settle does not stop the next resume keeping awake", async () => {
  await pauseDuringSettle((counts) => `echo run >> '${counts}'`);
});

// The helper the resume starts writes only after the settle: it is alive, so `keepAwake` says on, and its line is
// not in `counts` yet. The first helper still writes at once, so the pause still lands during its settle.
test("a pause during the helper's settle, then a resume whose helper is slow to write, still ends with two helpers started", async () => {
  await pauseDuringSettle((counts) => `if [ -e '${counts}' ]; then sleep 0.4; fi\necho run >> '${counts}'`);
});
