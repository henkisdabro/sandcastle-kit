// The live status view with no terminal on stdout: an agent's tool or `| grep` waited on the
// refreshing loop until its time limit killed it. Any interval now prints one frame and exits, as
// 0 does; STATUS_FRAMES still drives the loop, which the other status tests rely on. No Docker,
// no network, no model calls.
//
//   pnpm test:file test/status-no-terminal.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-no-terminal-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const REPO = join(TMP, "repo");
const FAKE = join(TMP, "bin");
mkdirSync(join(REPO, ".sandcastle"), { recursive: true });
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
script(join(FAKE, "sandcastle"), "#!/bin/sh\necho '[]'\n");
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
const git = (...a: string[]) => spawnSync("git", ["-C", REPO, "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");

const ALT_SCREEN = "\x1b[?1049h";

// stdout a pipe, stdin ignored: how an agent's tool or a `| grep` runs it. A view that does not
// end on its own is killed by the timeout, which shows as a signal and no exit status.
const view = (args: string[], extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${FAKE}:${process.env.PATH}`,
    SANDCASTLE_PROJECT: REPO,
    SANDCASTLE_BASE: "main",
    ...extra,
  };
  delete env.STATUS_FRAMES;
  Object.assign(env, extra);
  return spawnSync("bash", [join(KIT, "status.sh"), ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
};

for (const args of [["1"], []]) {
  test(`status ${args.join(" ") || "with no argument"} piped prints one frame and exits on its own`, () => {
    const r = view(args);
    assert.equal(r.signal, null, "the view had to be killed: it never exits with no terminal");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim().length > 0, "no frame printed");
    assert.ok(!r.stdout.includes(ALT_SCREEN), "the alternate screen was switched on for a pipe");
  });
}

test("status piped with STATUS_FRAMES set still runs the loop", () => {
  const r = view(["1"], { STATUS_FRAMES: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(ALT_SCREEN), "the loop did not run");
});
