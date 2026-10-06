// `sandcastle run` arguments: ticket ids, --dry and --concurrency N are aliases for ISSUES, DRY_RUN
// and CONCURRENCY; anything else is refused before config, Docker or any spend. No Docker, model or
// network.
//
//   node --test test/run-args.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperatorError } from "../src/errors.ts";
import { parseRunArgs } from "../src/run.ts";
import { runKit } from "./cli-spawn.ts";


test("no arguments leave everything to the environment", () => {
  assert.deepEqual(parseRunArgs([]), { dry: false });
});

test("ticket ids are collected in order", () => {
  assert.deepEqual(parseRunArgs(["12", "14"]), { dry: false, issues: ["12", "14"] });
});

test("--dry and ticket ids combine in any order", () => {
  assert.deepEqual(parseRunArgs(["--dry", "12"]), { dry: true, issues: ["12"] });
  assert.deepEqual(parseRunArgs(["12", "--dry"]), { dry: true, issues: ["12"] });
});

test("--concurrency takes the next argument as a number", () => {
  assert.deepEqual(parseRunArgs(["--concurrency", "2"]), { dry: false, concurrency: 2 });
});

test("a ticket-file slug is kept as an id", () => {
  assert.deepEqual(parseRunArgs(["feature-03"]), { dry: false, issues: ["feature-03"] });
});

for (const bad of [["--bogus"], ["--failed"], ["--concurrency"], ["--concurrency", "0"], ["--concurrency", "x"], ["--concurrency=2"]]) {
  test(`${bad.join(" ")} is refused with the usage line`, () => {
    assert.throws(
      () => parseRunArgs(bad),
      (e) => e instanceof OperatorError && e.message.includes("Usage: sandcastle run"),
    );
  });
}

test("a bad argument is a message with no stack, before any config is read", () => {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-run-args-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const r = runKit(["run", "--bogus"], {
    cwd: root,
    encoding: "utf8",
    // Never discover a repository above the throwaway directory.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('Unknown argument "--bogus"'), r.stderr);
  assert.ok(r.stderr.includes("Usage: sandcastle run"), r.stderr);
  assert.ok(!r.stderr.split("\n").some((l) => /^\s+at /.test(l)), `stack trace in:\n${r.stderr}`);
});
