// The pointer to `sandcastle size` while both pool limits are the untouched defaults: `doctor` prints
// it as an `info` line (never a FIX or warn, so "All required checks pass" is unchanged), `setup`
// prints it after its checks, and either limit set - in config.json or the environment - silences
// both. Doctor runs as a child against a temp XDG_CONFIG_HOME; setup needs a terminal, Docker and
// tokens, so its wiring is read from the source and its line from the function it calls. No Docker.
//
//   pnpm test:file test/doctor-size-pointer.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const tmp = mkdtempSync(join(tmpdir(), "sc-sizeptr-"));
process.env.XDG_CONFIG_HOME = join(tmp, "config");
const { sizePointer } = await import("../src/size.ts");

const POINTER = "info The machine pool's limits are the untouched defaults: run `sandcastle size` to see what this machine can take.";

// Doctor in its own config directory, with the given config.json and environment.
const doctor = (name: string, config: string | undefined, env: Record<string, string> = {}) => {
  const home = join(tmp, name);
  const xdg = join(home, "config");
  mkdirSync(join(xdg, "sandcastle-kit"), { recursive: true });
  if (config !== undefined) writeFileSync(join(xdg, "sandcastle-kit/config.json"), config);
  const r = runKit(["doctor"], {
    encoding: "utf8",
    cwd: home,
    env: {
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      XDG_CACHE_HOME: join(home, "cache"),
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: tmp,
      ...env,
    },
  });
  return r.stdout + r.stderr;
};

test("doctor prints the pointer as an info line while neither limit is set", () => {
  const out = doctor("none", undefined);
  assert.equal(out.split("\n").filter((l) => l === POINTER).length, 1, out);
  assert.doesNotMatch(out, /(FIX|warn) +The machine pool/);
});

test("doctor's pointer leaves the required checks as they were", () => {
  const withPointer = doctor("same-a", undefined);
  const without = doctor("same-b", '{"maxGates": 2}');
  const tail = (out: string) => out.trim().split("\n").at(-1);
  assert.equal(tail(withPointer), tail(without));
  assert.doesNotMatch(withPointer, /^FIX .*pool/m);
});

for (const [name, config, env] of [
  ["maxSandboxes", '{"maxSandboxes": 4}', {}],
  ["maxGates", '{"maxGates": 1}', {}],
  ["SANDCASTLE_MAX_SANDBOXES", undefined, { SANDCASTLE_MAX_SANDBOXES: "4" }],
  ["SANDCASTLE_MAX_GATES", undefined, { SANDCASTLE_MAX_GATES: "1" }],
] as const) {
  test(`doctor prints no pointer once ${name} is set`, () => {
    assert.doesNotMatch(doctor(`set-${name}`, config, env), /untouched defaults/);
  });
}

test("doctor prints no pointer when config.json cannot be read (its own FIX says so)", () => {
  const out = doctor("broken", "{not json");
  assert.doesNotMatch(out, /untouched defaults/);
  assert.match(out, /FIX .*machine-wide settings/);
});

test("sizePointer: the line setup prints, only while no limit is set", () => {
  assert.equal(`info ${sizePointer({}, {})}`, POINTER);
  assert.equal(sizePointer({}, { keepAwake: true, idleMark: false }) !== undefined, true);
  assert.equal(sizePointer({}, { maxSandboxes: 6 }), undefined);
  assert.equal(sizePointer({}, { maxGates: 2 }), undefined);
  assert.equal(sizePointer({ SANDCASTLE_MAX_SANDBOXES: "6" }, {}), undefined);
  assert.equal(sizePointer({ SANDCASTLE_MAX_GATES: "2" }, {}), undefined);
});

test("setup prints the pointer after its checks, once; init says nothing", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, "..", "src", f), "utf8");
  const setup = src("setup.ts");
  // Doctor is told not to print it, so the line is not said twice, and setup prints it after doctor.
  assert.match(setup, /await doctor\(repoRoot, false, false\);\s*(\/\/.*\s*)*const pointer = sizePointerNow\(\);\s*if \(pointer\) console\.log\(/);
  assert.doesNotMatch(src("init.ts"), /sizePointer/);
});
