// Every test file starts from the same environment (test/hermetic-env.ts, preloaded beside
// test/no-stray.ts): a canonical TMPDIR, the running node's directory first on PATH, and none of the
// host's HERDR_*, TMUX*, SANDCASTLE_* or kit settings. Also the guard against a new setting leaking in:
// a name `src/` reads from the environment must be scrubbed or on the keep list below.
//
//   node --import ./test/hermetic-env.ts --test test/hermetic-env.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { KIT, runNode } from "./cli-spawn.ts";
import { scrubs } from "./hermetic-env.ts";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "sandcastle-hermetic-env-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Names `src/` reads that a test keeps from the host: where things live, not what the kit does. */
const KEEP = [/^PATH$/, /^HOME$/, /^SHELL$/, /^XDG_/, /^GIT_CONFIG_/, /^SANDCASTLE_TEST_/];

/** The environment names `src/` reads: `env.NAME`, `env["NAME"]`, `effort("NAME")`, a pool setting's `env: "NAME"` and the named lists. */
const namesRead = (): Map<string, string> => {
  const found = new Map<string, string>();
  const add = (name: string, file: string) => found.has(name) || found.set(name, file);
  for (const file of readdirSync(join(KIT, "src")).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(KIT, "src", file), "utf8");
    for (const m of text.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*)\b/g)) add(m[1]!, file);
    for (const m of text.matchAll(/\benv\??\.?\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g)) add(m[1]!, file);
    for (const m of text.matchAll(/\beffort\(\s*"([A-Z][A-Z0-9_]*)"/g)) add(m[1]!, file);
    for (const m of text.matchAll(/\benv: "([A-Z][A-Z0-9_]*)"/g)) add(m[1]!, file);
    for (const m of text.matchAll(/\b(?:TERMINAL_KEYS|KIT_CREDENTIALS|HOST_ONLY_KEYS)\b[^=\n]*=\s*\[([^\]]*)\]/g)) for (const n of m[1]!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)) add(n[1]!, file);
    for (const m of text.matchAll(/\b(\w+_ENV)\s*=\s*"([A-Z][A-Z0-9_]*)"/g)) add(m[2]!, file);
  }
  return found;
};

test("a test sees tmpdir() equal to its realpath, and the running node's directory first on PATH", () => {
  assert.equal(tmpdir(), realpathSync(tmpdir()));
  assert.equal(process.env.PATH!.split(delimiter)[0], dirname(process.execPath));
});

test("a test sees none of the host's Herdr, tmux or kit settings", () => {
  for (const name of Object.keys(process.env)) assert.equal(scrubs(name), false, `${name} leaked into the test's environment`);
});

test("a polluted shell reaches a test file as the canonical environment", () => {
  const real = join(dir, "real");
  mkdirSync(real);
  const link = join(dir, "link");
  symlinkSync(real, link);
  const out = join(dir, "seen.json");
  const file = join(dir, "probe.test.ts");
  writeFileSync(
    file,
    `import { writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { test } from "node:test";\n` +
      `test("probe", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify({ tmp: tmpdir(), path: process.env.PATH, env: process.env })));\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: link,
    PATH: `/shim${delimiter}${process.env.PATH}`,
    HERDR_ENV: "1", HERDR_PANE_ID: "p", TMUX: "x", TMUX_PANE: "%1", AUTONOMY_LEVEL: "3", CONCURRENCY: "9", USAGE_CHECK: "1",
    SANDCASTLE_DETACHED: "1", SANDCASTLE_TEST_TEMP: "kept", GH_TOKEN: "t", NO_COLOR: "1", XDG_CONFIG_HOME: "/xdg",
  };
  delete env.NODE_TEST_CONTEXT;
  const r = runNode(["--import", join(KIT, "test/hermetic-env.ts"), "--test", "--test-reporter=spec", file], { cwd: dir, env, encoding: "utf8", timeoutMs: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const seen = JSON.parse(readFileSync(out, "utf8")) as { tmp: string; path: string; env: Record<string, string> };
  assert.equal(seen.tmp, realpathSync(real));
  assert.equal(seen.path.split(delimiter)[0], dirname(process.execPath));
  assert.ok(seen.path.split(delimiter).includes("/shim"), "the host's own PATH entries stay");
  for (const gone of ["HERDR_ENV", "HERDR_PANE_ID", "TMUX", "TMUX_PANE", "AUTONOMY_LEVEL", "CONCURRENCY", "USAGE_CHECK", "SANDCASTLE_DETACHED", "GH_TOKEN", "NO_COLOR"]) assert.equal(seen.env[gone], undefined, gone);
  assert.equal(seen.env.SANDCASTLE_TEST_TEMP, "kept");
  assert.equal(seen.env.XDG_CONFIG_HOME, "/xdg");
});

test("the test scripts in package.json and test/run-shards.sh preload it beside the stray-output guard", () => {
  const { scripts } = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const name of ["test", "test:shard", "test:weights"]) assert.match(scripts[name]!, /--import \.\/test\/hermetic-env\.ts --import \.\/test\/no-stray\.ts --test /, name);
  assert.match(readFileSync(join(KIT, "test/run-shards.sh"), "utf8"), /--import \.\/test\/hermetic-env\.ts --import \.\/test\/no-stray\.ts --test /);
});

test("every environment name src/ reads is scrubbed for a test or on the keep list", () => {
  const read = namesRead();
  // A scan that found nothing would pass for ever.
  for (const known of ["AUTONOMY_LEVEL", "HERDR_ENV", "SANDCASTLE_MAX_GATES", "CROSS_REVIEW_EFFORT", "TERM_PROGRAM", "LINEAR_API_KEY", "GH_TOKEN", "XDG_CONFIG_HOME", "SANDCASTLE_DOCKER_INFO"]) {
    assert.ok(read.has(known), `the scan did not find ${known}`);
  }
  const loose = [...read].filter(([name]) => !scrubs(name) && !KEEP.some((k) => k.test(name))).map(([name, file]) => `${name} (src/${file})`);
  assert.deepEqual(loose, [], "scrub these in test/hermetic-env.ts (SCRUBBED), or add them to KEEP in test/hermetic-env.test.ts if a test needs the host's value");
});
