// `exitOnSignal` (src/run.ts): a hangup, Ctrl-C or kill outside sandbox work ends the
// process through its exit handlers; while the library's own listeners are registered
// (stood in for by LIBRARY=1) the teardown is left to them. One real process per case,
// no Docker, no network, no model.
//
//   pnpm exec tsx --test test/signals.test.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "sandcastle-signals-"));
const marker = join(dir, "marker");
const library = join(dir, "library");
const fixture = join(dir, "fixture.mts");
writeFileSync(
  fixture,
  `import { writeFileSync } from "node:fs";
import { exitOnSignal } from ${JSON.stringify(join(KIT, "src/run.ts"))};
exitOnSignal();
process.on("exit", (c) => writeFileSync(${JSON.stringify(marker)}, "exit " + c));
if (process.env.LIBRARY === "1") {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { writeFileSync(${JSON.stringify(library)}, "library"); process.exit(1); });
  }
}
console.log("ready");
setInterval(() => {}, 1000);
`,
);

// One process, not the tsx binary: that forks a child and may not forward SIGHUP.
const run = (sig: NodeJS.Signals, env: Record<string, string> = {}) =>
  new Promise<number | null>((resolve, reject) => {
    for (const f of [marker, library]) rmSync(f, { force: true });
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: KIT,
      env: { ...process.env, XDG_CACHE_HOME: dir, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    let sent = false;
    let again: NodeJS.Timeout | undefined;
    child.stdout.on("data", (d) => {
      out += d;
      if (sent || !out.includes("ready")) return;
      sent = true;
      child.kill(sig);
      // Under a loaded full suite on macOS the first signal is occasionally not acted on
      // (seen only with SIGINT, never reproduced alone). An operator presses Ctrl-C again;
      // so does the test, once, before the 15 s limit calls it a hang.
      again = setTimeout(() => child.kill(sig), 5_000);
    });
    // A fixture that survives its signal once hung the whole macOS suite for minutes; fail
    // instead, naming the signal, and never leave the process behind.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture still running 15 s after ${sig}${out.includes("ready") ? "" : " (it never printed ready)"}`));
    }, 15_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      clearTimeout(again);
      resolve(code);
    });
  });

for (const [sig, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const) {
  test(`${sig} with no library listener exits ${code} through the exit handlers`, async () => {
    assert.equal(await run(sig), code);
    assert.equal(readFileSync(marker, "utf8"), `exit ${code}`);
  });
}

for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
  test(`${sig} with a library listener leaves the teardown to it`, async () => {
    assert.equal(await run(sig, { LIBRARY: "1" }), 1);
    assert.equal(readFileSync(library, "utf8"), "library");
  });
}
