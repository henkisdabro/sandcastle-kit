// A person's `sandcastle pause` landing between the usage timer's read of the control file and its
// write must survive: the timer never replaces or undoes a person's pause. The timer's read is held
// open from inside (the file's read is wrapped), and the person's `pause` runs as a second process
// in that gap, so the two sequences really interleave. No Docker, no model, no network.
//
//   node --test test/pause-race.test.ts

import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { UsagePaused } from "../mod/hooks/run-record.ts";
import { startNode } from "./cli-spawn.ts";

// pool.ts derives its directories from these at import: nothing here may touch the user's.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { PAUSE_FILE, holdForUsage, readPause, resumeRun } = await import("../src/detach.ts");
const { inject } = await import("../src/pool.ts");
const { everyPidIsTheKit } = await import("./kit-process.ts");

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-pause-race-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PID = 4242;
const T0 = Math.floor(Date.now() / 1000);
const usage: UsagePaused = { cause: "usage", provider: "claude", window: "fiveHour", percent: 95, resumesAt: T0 + 7200 };

const project = () => {
  const root = mkdtempSync(join(TMP, "project"));
  mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
  writeFileSync(join(root, ".sandcastle/logs/run.lock"), `${PID} token project\n`);
  return root;
};

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The person's `sandcastle pause` as a process of its own, which says when it is about to ask. */
const personPauses = (root: string, started: string) =>
  startNode([
    "--input-type=module",
    "-e",
    `import { writeFileSync } from "node:fs";
     const { pauseRun } = await import(${JSON.stringify(new URL("../src/detach.ts", import.meta.url).href)});
     const { inject } = await import(${JSON.stringify(new URL("../src/pool.ts", import.meta.url).href)});
     inject({ probe: () => "node src/cli.ts run" });
     writeFileSync(${JSON.stringify(started)}, "1");
     process.stdout.write(JSON.stringify(pauseRun(${JSON.stringify(root)}, () => "node src/cli.ts run", () => ${T0 + 60})));`,
  ], { stdio: ["ignore", "pipe", "inherit"] });

test("a person's pause that lands between the usage timer's read and its write is not replaced", async () => {
  const root = project();
  // This process holds the lock as a process of the kit, which the person's process sees from outside.
  inject({ probe: everyPidIsTheKit });
  const started = join(TMP, "person-started");
  let person: ReturnType<typeof personPauses> | undefined;
  let said = "";
  const read = fs.readFileSync;
  let held = false;
  // The timer's own read of the control file: once it has read, hold it open until the person's
  // process is asking, and a little longer for it to have written, were nothing to stop it.
  (fs as unknown as { readFileSync: unknown }).readFileSync = ((file: unknown, ...rest: unknown[]) => {
    try {
      return (read as (...a: unknown[]) => unknown)(file, ...rest);
    } finally {
      // The file is not there yet, so the read throws: the gap opens after it either way.
      if (!held && String(file) === join(root, PAUSE_FILE)) {
        held = true;
        person = personPauses(root, started);
        person.stdout!.on("data", (d) => (said += d));
        for (let i = 0; i < 4000 && !existsSync(started); i++) sleepSync(5);
        sleepSync(500);
      }
    }
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    // No pause stands, so the timer's read finds none: it will write its own.
    holdForUsage(root, PID, usage, T0);
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = read;
    syncBuiltinESMExports();
    inject();
  }
  assert.ok(person, "the timer read the control file");
  await new Promise((resolve) => person!.once("exit", resolve));

  assert.equal(JSON.parse(said).kind, "taken over", "the person's pause found the timer's, and took it over");
  assert.deepEqual(readPause(root, PID, T0 + 61), { since: T0 }, "the person's pause stands: no cause, no time to resume at");
  assert.deepEqual(readPause(root, PID, T0 + 100_000), { since: T0 }, "and no reset resumes it");
});

test("the usage timer and a person's resume leave no lock behind", () => {
  const root = project();
  inject({ probe: everyPidIsTheKit });
  try {
    holdForUsage(root, PID, usage, T0);
    assert.equal(resumeRun(root, everyPidIsTheKit).kind, "resumed");
  } finally {
    inject();
  }
  assert.equal(existsSync(join(root, `${PAUSE_FILE}.lock`)), false);
  assert.equal(readPause(root, PID, T0), undefined);
});
