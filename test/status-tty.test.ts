// The live status view with no terminal: it still runs and leaves no stty error. (The view on a
// terminal - echo and alternate scroll off while it runs, put back on exit, Ctrl-C at once - is
// held from outside in test/status-lifecycle.test.ts.) A fake `sandcastle` and `docker`; no Docker,
// no network, no model calls.
//
//   pnpm test:file test/status-tty.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { spawnStatus } from "./status-run.ts";

const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-tty-"));
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

test("without a terminal the view still runs and leaves no stty error", () => {
  // STATUS_FRAMES keeps the loop for a test that drives it (status.sh's header): one frame, with nothing to read the size from.
  const r = spawnStatus(["1"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, SANDCASTLE_PROJECT: REPO, SANDCASTLE_BASE: "main", STATUS_FRAMES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/stty|tty/i.test(r.stderr), r.stderr);
});
