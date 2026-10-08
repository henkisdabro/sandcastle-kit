// Numeric settings and the machine config file: a bad value is refused with a
// message naming it, never NaN (no workers, an endless slot wait) or a raw
// JSON stack, and importing pool.ts stays safe so doctor can report it.
//
//   pnpm test:file test/settings.test.ts

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OperatorError } from "../src/errors.ts";
import { runKit, runNode } from "./cli-spawn.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), "sandcastle-settings-"));

// Each case runs in a child process: the settings are read once per process.
const probe = (env: Record<string, string>, code: string) => {
  const r = runNode(["--input-type=module", "-e", code], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: temp(), XDG_CONFIG_HOME: temp(), ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

test("wholeNumber rejects NaN, zero, negatives and fractions, and accepts a whole number", async () => {
  process.env.XDG_CACHE_HOME = temp();
  const { wholeNumber } = await import("../src/pool.ts");
  for (const bad of ["abc", "0", "-1", "1.5", "", " ", null, true, NaN]) {
    assert.throws(() => wholeNumber("CONCURRENCY", bad, 1), (e: Error) => e instanceof OperatorError && /^CONCURRENCY=.* - expected a whole number of 1 or more\.$/.test(e.message), String(bad));
  }
  assert.equal(wholeNumber("CONCURRENCY", "3", 1), 3);
  assert.equal(wholeNumber("CONCURRENCY", 4, 1), 4);
  assert.equal(wholeNumber("X", "0", 0), 0);
});

test("importing pool.ts with a bad limit does not throw; limit() does", () => {
  const r = probe(
    { SANDCASTLE_MAX_SANDBOXES: "abc" },
    `const pool = await import("./src/pool.ts");
     console.log("imported");
     try { pool.limit("sandboxes"); } catch (e) { console.log(e.message); }
     console.log(pool.limit("gates"));`,
  );
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /imported\nSANDCASTLE_MAX_SANDBOXES=abc - expected a whole number of 1 or more\.\n2\n/);
});

test("a bad maxGates in config.json is refused under its own key, not the env var", () => {
  const config = temp();
  mkdirSync(join(config, "sandcastle-kit"));
  writeFileSync(join(config, "sandcastle-kit", "config.json"), '{"maxGates": 0}');
  const r = probe({ XDG_CONFIG_HOME: config }, `const pool = await import("./src/pool.ts"); try { pool.limit("gates"); } catch (e) { console.log(e.message); }`);
  assert.match(r.out, /^maxGates=0 - expected a whole number of 1 or more/);
});

test("a malformed config.json names the file, and importing pool.ts still works", () => {
  const config = temp();
  mkdirSync(join(config, "sandcastle-kit"));
  const file = join(config, "sandcastle-kit", "config.json");
  writeFileSync(file, "{ not json");
  const r = probe(
    { XDG_CONFIG_HOME: config },
    `await import("./src/pool.ts");
     const { machineSettings } = await import("./src/sandbox.ts");
     try { machineSettings(); } catch (e) { console.log(e.constructor.name, e.message); }`,
  );
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.startsWith("OperatorError "), r.out);
  assert.ok(r.out.includes(`${file} is not valid JSON: `), r.out);
});

test("a config.json that is not an object is refused", () => {
  const config = temp();
  mkdirSync(join(config, "sandcastle-kit"));
  writeFileSync(join(config, "sandcastle-kit", "config.json"), "null");
  const r = probe({ XDG_CONFIG_HOME: config }, `const { machineSettings } = await import("./src/sandbox.ts"); try { machineSettings(); } catch (e) { console.log(e.message); }`);
  assert.match(r.out, /config\.json is not a JSON object\./);
});

test("doctor reports a malformed config.json as a FIX line instead of crashing", () => {
  const config = temp();
  mkdirSync(join(config, "sandcastle-kit"));
  writeFileSync(join(config, "sandcastle-kit", "config.json"), "{ not json");
  // This node, not bin/sandcastle: it finds `node` on PATH, and a mise or
  // asdf shim there reads its own config from XDG_CONFIG_HOME, which this test
  // points at a temp dir - the shim then exits before the kit runs. Both agent versions pinned:
  // doctor resolves them, and unpinned that is a fetch of the release channel and npm.
  const r = runKit(["doctor"], {
    cwd: temp(),
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: temp(), CLAUDE_CODE_VERSION: "2.1.0", CODEX_VERSION: "0.1.0" },
  });
  assert.match(r.stdout, /FIX +machine-wide settings[\s\S]*is not valid JSON/);
  assert.doesNotMatch(r.stderr, /SyntaxError/);
});
