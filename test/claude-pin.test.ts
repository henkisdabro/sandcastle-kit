// The warning `sandcastle doctor` prints when this machine's Claude Code is newer than the
// image's pin: the pure helper, the real Dockerfile's pin, and one doctor run with a fake
// `claude` first on PATH. No Docker, no model calls, no network.
//
//   pnpm exec tsx --test test/claude-pin.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Importing doctor.ts must not touch the real slots.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "sandcastle-test-"));
const { claudePinWarning } = await import("../src/doctor.ts");

const kit = fileURLToPath(new URL("..", import.meta.url));
const pinned = (v: string) => `FROM node\nARG CLAUDE_CODE_VERSION=${v}\nRUN true\n`;

test("a newer host gets the exact line", () => {
  assert.equal(
    claudePinWarning("ARG CLAUDE_CODE_VERSION=2.1.285\n", "2.1.290 (Claude Code)"),
    "Claude Code here is 2.1.290, newer than the sandbox image's pin 2.1.285 (docker/base.Dockerfile)",
  );
});

test("the same or an older host gets none", () => {
  assert.equal(claudePinWarning(pinned("2.1.285"), "2.1.285 (Claude Code)"), undefined);
  assert.equal(claudePinWarning(pinned("2.1.285"), "2.1.200 (Claude Code)"), undefined);
});

test("versions compare as numbers, not text", () => {
  assert.ok(claudePinWarning(pinned("2.1.285"), "2.1.1000 (Claude Code)"));
  assert.ok(claudePinWarning(pinned("2.9.9"), "2.10.0 (Claude Code)"));
  assert.equal(claudePinWarning(pinned("2.1.285"), "2.1.29 (Claude Code)"), undefined);
});

test("nothing readable means no warning", () => {
  assert.equal(claudePinWarning(pinned("2.1.285"), undefined), undefined);
  assert.equal(claudePinWarning(pinned("2.1.285"), "command not found"), undefined);
  assert.equal(claudePinWarning("FROM node\nRUN true\n", "999.0.0 (Claude Code)"), undefined);
});

test("the kit's real Dockerfile has a pin the helper reads", () => {
  const line = claudePinWarning(readFileSync(join(kit, "docker/base.Dockerfile"), "utf8"), "999.0.0");
  assert.match(line ?? "", /pin \d+(\.\d+)*/);
});

test("doctor prints the warning for a newer claude on PATH", () => {
  const bin = mkdtempSync(join(tmpdir(), "sandcastle-fake-bin-"));
  const fake = join(bin, "claude");
  writeFileSync(fake, '#!/bin/sh\necho "999.0.0 (Claude Code)"\n');
  chmodSync(fake, 0o755);
  const result = spawnSync(process.execPath, [join(kit, "node_modules/tsx/dist/cli.mjs"), join(kit, "src/cli.ts"), "doctor"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: mkdtempSync(join(tmpdir(), "sandcastle-cwd-")),
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      GIT_CEILING_DIRECTORIES: tmpdir(),
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "sandcastle-config-")),
      XDG_CACHE_HOME: mkdtempSync(join(tmpdir(), "sandcastle-cache-")),
    },
  });
  // Only the warn line: the rest of doctor's output depends on the machine.
  assert.match(result.stdout, /^warn Claude Code here is 999\.0\.0/m);
});
