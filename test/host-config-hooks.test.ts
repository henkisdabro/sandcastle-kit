// From git 2.54 a hook can be defined in config (`hook.<name>.command` and `.event`), and the host's
// `core.hooksPath=/dev/null` does not reach it: one a sandbox wrote in `.git/config` or `config.worktree` ran on
// the host's next commit, and a `reference-transaction` one on every ref a landing moves. After the start's pins
// the host's git runs none, and on git 2.55+ not one named only after the start either. No Docker, model calls or
// network.
//
//   pnpm test:file test/host-config-hooks.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { disableHostGitHooks, pinHostGitConfig } from "../src/guard.ts";

const gitAtLeast = (major: number, minor: number) => {
  const [a, b] = execFileSync("git", ["--version"], { encoding: "utf8" }).match(/(\d+)\.(\d+)/)!.slice(1).map(Number);
  return a > major || (a === major && b >= minor);
};

test("the host's git runs no config-defined hook, from .git/config, config.worktree or planted after the start", { skip: !gitAtLeast(2, 54) && "git before 2.54 has no config-defined hooks" }, () => {
  const saved = { ...process.env };
  try {
    const root = mkdtempSync(join(tmpdir(), "sandcastle-config-hooks-"));
    const ran = join(root, "ran");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "extensions.worktreeConfig", "true");
    const plant = (name: string, event: string, ...scope: string[]) => {
      git("config", ...scope, `hook.${name}.event`, event);
      git("config", ...scope, `hook.${name}.command`, `echo ${name} >> '${ran}'; :`);
    };
    plant("local", "pre-commit");
    plant("refs", "reference-transaction");
    plant("worktree", "post-commit", "--worktree");
    // The control: the hooks run without the pins, so their silence below is the pins' doing.
    git("commit", "-q", "--allow-empty", "-m", "unpinned");
    assert.deepEqual(new Set(readFileSync(ran, "utf8").trim().split("\n")), new Set(["local", "refs", "worktree"]));
    rmSync(ran);

    const silent = (message: string) => {
      git("commit", "-q", "--allow-empty", "-m", message);
      git("update-ref", `refs/heads/${message}`, "HEAD");
      assert.equal(existsSync(ran) ? readFileSync(ran, "utf8") : "", "", message);
    };
    // The pins by name alone, all git 2.54 has; the per-event switch would hide them from 2.55.
    pinHostGitConfig(root);
    silent("by-name");
    disableHostGitHooks();
    if (gitAtLeast(2, 55)) plant("later", "post-commit");
    silent("by-event");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
