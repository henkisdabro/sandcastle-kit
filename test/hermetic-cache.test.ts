// A test file's kit cache is its own (test/hermetic-env.ts): a test's `--version --json` or `doctor` looks up
// the kit's newest release (src/upgrading.ts), keyed by this checkout and its `origin`, and the read, refused
// in a test, was cached as a failure in the developer's own ~/.cache - their idle mark and doctor then named
// no newer release for an hour. Here a "host" cache stands for that one; no network, no Docker.
//
//   pnpm test:file test/hermetic-cache.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT, runNode } from "./cli-spawn.ts";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "sandcastle-hermetic-cache-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The lookup reads only a checkout with an `origin` (as git reports it): a copy of the tree without one (the full
// check's Linux leg) reads nothing and caches nothing, so there is nothing to hold here.
const origin = spawnSync("git", ["-C", KIT, "ls-remote", "--get-url", "origin"], { encoding: "utf8" });
const hasOrigin = origin.status === 0 && !["", "origin"].includes(origin.stdout.trim());

const entries = (cache: string) => {
  const releases = join(cache, "sandcastle-kit", "newest-release");
  return existsSync(releases) ? readdirSync(releases) : [];
};

test("a test's `--version --json` writes its newest-release answer to a cache of its own, never the shell's", { skip: !hasOrigin && "this checkout has no origin, so no newest-release read is made" }, () => {
  const host = join(dir, "host-cache");
  mkdirSync(host);
  const out = join(dir, "seen.json");
  const file = join(dir, "probe.test.ts");
  writeFileSync(
    file,
    `import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nimport { test } from "node:test";\n` +
      `import { runKit } from ${JSON.stringify(join(KIT, "test/cli-spawn.ts"))};\n` +
      `test("probe", () => {\n` +
      `  const r = runKit(["--version", "--json"], { cwd: mkdtempSync(join(tmpdir(), "probe-")), encoding: "utf8" });\n` +
      `  const releases = join(process.env.XDG_CACHE_HOME ?? "", "sandcastle-kit", "newest-release");\n` +
      `  const own = existsSync(releases) ? readdirSync(releases) : [];\n` +
      `  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ status: r.status, stderr: r.stderr, cache: process.env.XDG_CACHE_HOME, tmp: tmpdir(), own }));\n` +
      `});\n`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: host };
  delete env.NODE_TEST_CONTEXT;
  const r = runNode(["--import", join(KIT, "test/hermetic-env.ts"), "--test", "--test-reporter=spec", file], { cwd: dir, env, encoding: "utf8", timeoutMs: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const seen = JSON.parse(readFileSync(out, "utf8")) as { status: number; stderr: string; cache: string; tmp: string; own: string[] };
  assert.equal(seen.status, 0, seen.stderr);
  // The lookup ran (this checkout has an origin), and its answer went to the test's own cache.
  assert.equal(seen.own.length, 1, "no newest-release read was cached at all");
  assert.ok(seen.cache.startsWith(seen.tmp), `the test's cache ${seen.cache} is not in its TMPDIR ${seen.tmp}`);
  assert.deepEqual(entries(host), [], "the test's newest-release read was cached in the shell's cache");
});
