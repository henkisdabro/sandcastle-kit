// `exitOnSignal` (src/run.ts): a hangup, Ctrl-C or kill outside sandbox work ends the
// process through its exit handlers; while the library's own listeners are registered
// (stood in for by LIBRARY=1) the teardown is left to them. Without one, the exit listeners run
// once and the process dies by the signal itself - never through `process.exit`, which can
// deadlock on Node 24 (nodejs/node#66171). One real process per case,
// no Docker, no network, no model.
//
//   node --test test/signals.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { flagsOf, launcherLines, NODE_FLAGS, runNode, startNode } from "./cli-spawn.ts";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "sandcastle-signals-"));
const marker = join(dir, "marker");
const library = join(dir, "library");
const exitCalled = join(dir, "exit-called");
const fixture = join(dir, "fixture.mts");
writeFileSync(
  fixture,
  `import { appendFileSync, writeFileSync } from "node:fs";
import { exitOnSignal } from ${JSON.stringify(join(KIT, "src/run.ts"))};
exitOnSignal();
// Every exit listener's run is one line: a second run would show as a second line.
process.on("exit", (c) => appendFileSync(${JSON.stringify(marker)}, "exit " + c + "\\n"));
// The signal path must end the process by the signal; a call here is the deadlock-prone way out.
const realExit = process.exit;
process.exit = ((c?: number) => { if (!process.env.LIBRARY) writeFileSync(${JSON.stringify(exitCalled)}, "exit() " + c); return realExit(c); }) as typeof process.exit;
if (process.env.LIBRARY === "1") {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { writeFileSync(${JSON.stringify(library)}, "library"); process.exit(1); });
  }
}
console.log("ready");
setInterval(() => {}, 1000);
`,
);

// The node flags the launcher passes (`exec node <flags> --import ...`), so the fixture runs as the
// CLI does.

test("the launcher turns concurrent Maglev and Sparkplug off on both exec lines", () => {
  assert.equal(launcherLines.length, 2, "the herdr line and the CLI line");
  for (const line of launcherLines) assert.deepEqual(flagsOf(line), ["--no-maglev", "--no-concurrent-sparkplug"]);
});

test("a detached run is started with the launcher's node flags", () => {
  const res = runNode(["-p", "JSON.stringify(process.execArgv)"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  assert.deepEqual(JSON.parse(res.stdout).slice(0, NODE_FLAGS.length), NODE_FLAGS, "process.execArgv, which src/detach.ts cliEntry passes on, carries the V8 flags");
});

// One process, never a wrapper that forks a child (tsx's binary did) and may not forward SIGHUP.
const run = (sig: NodeJS.Signals, env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    for (const f of [marker, library, exitCalled]) rmSync(f, { force: true });
    const child = startNode([fixture], {
      cwd: KIT,
      env: { ...process.env, XDG_CACHE_HOME: dir, ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    let sent = false;
    let again: NodeJS.Timeout | undefined;
    child.stdout!.on("data", (d) => {
      out += d;
      if (sent || !out.includes("ready")) return;
      sent = true;
      child.kill(sig);
      // An operator presses Ctrl-C again when nothing happens; so does the test, once, before the
      // 15 s limit calls it a hang.
      again = setTimeout(() => child.kill(sig), 5_000);
    });
    // A fixture that survives its signal once hung the whole macOS suite for minutes; fail
    // instead, naming the signal, and never leave the process behind.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture still running 15 s after ${sig}${out.includes("ready") ? "" : " (it never printed ready)"}`));
    }, 15_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(again);
      resolve({ code, signal });
    });
  });

for (const [sig, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const) {
  test(`${sig} with no library listener runs the exit handlers once and dies by ${sig} (shell status ${code})`, async () => {
    const ended = await run(sig);
    assert.equal(ended.signal, sig);
    assert.equal(ended.code, null);
    assert.equal(readFileSync(marker, "utf8"), `exit ${code}\n`);
    assert.equal(existsSync(exitCalled), false, "process.exit was called");
  });
}

for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
  test(`${sig} with a library listener leaves the teardown to it`, async () => {
    const ended = await run(sig, { LIBRARY: "1" });
    assert.equal(ended.code, 1);
    assert.equal(ended.signal, null);
    assert.equal(readFileSync(library, "utf8"), "library");
  });
}
