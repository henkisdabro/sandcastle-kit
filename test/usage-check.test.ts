// USAGE_CHECK=1: a bad USAGE_STOP is refused before the run does anything (it was refused after the
// image and preflight had run), and an unknown reading says why rather than always "rate-limited".
// A stubbed fetch; no network or model calls.
//
//   pnpm exec tsx --test test/usage-check.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

process.env.USAGE_CHECK = "1";
const { usageLine } = await import("../src/usage.ts");

test("a bad USAGE_STOP is refused before the run lists its queue or checks the image", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sandcastle-usage-cli-"));
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd });
  mkdirSync(join(cwd, ".sandcastle"));
  writeFileSync(join(cwd, ".sandcastle/config.ts"), 'export default { name: "t", gates: [{ name: "g", command: "true" }] };\n');
  const r = runKit(["run"], {
    cwd,
    env: { ...process.env, USAGE_CHECK: "1", USAGE_STOP: "abc", XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-test-")), GIT_CEILING_DIRECTORIES: tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("USAGE_STOP=abc - expected 1 to 100."), r.stderr);
  // Nothing before the refusal: no queue listed, no versions resolved, no preflight.
  assert.doesNotMatch(r.stdout, /issue\(s\)|Claude Code \d|Preflight|No .* tickets/, r.stdout);
});

test("an unknown reading names its cause", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const line = await usageLine({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
    assert.match(line ?? "", /^Plan usage: unknown right now \(the usage endpoint answered HTTP 401, token refused\); the run goes ahead/);
    assert.doesNotMatch(line ?? "", /rate-limited/);
  } finally {
    globalThis.fetch = real;
  }
});
