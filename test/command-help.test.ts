// `sandcastle <command> --help` (and `-h`) prints help and changes nothing: `clean --help` once ran
// the clean and deleted the agent branches. Each command is run against a temp repo holding a
// merged `agent/issue-1` branch, which must still be there afterwards. No Docker, model calls or
// network.
//
//   pnpm exec tsx --test test/command-help.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const kit = fileURLToPath(new URL("..", import.meta.url));
// Not bin/sandcastle or node_modules/.bin/tsx: those find `node` on PATH.
const cli = (file: string, args: string[], cwd: string, config: string) =>
  spawnSync(process.execPath, [join(kit, "node_modules/tsx/dist/cli.mjs"), join(kit, file), ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: config, HERDR_CONFIG_PATH: join(config, "herdr.toml"), GIT_CEILING_DIRECTORIES: tmpdir() },
  });

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-cmdhelp-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  git(dir, "branch", "agent/issue-1"); // already merged into main: what `clean` deletes
  return dir;
};

const COMMANDS = ["setup", "doctor", "run", "wait", "stop", "report", "status", "build", "preflight", "queue", "requeue", "blockers", "gates", "land", "preview", "lean", "init", "updated", "clean", "lean-apply", "herdr"];

test("clean --help prints the clean entry and leaves a merged agent branch alone", () => {
  const dir = project();
  const config = mkdtempSync(join(tmpdir(), "sandcastle-cmdhelp-cfg-"));
  const r = cli("src/cli.ts", ["clean", "--help"], dir, config);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean \[--all\]/);
  assert.ok(!r.stdout.includes("setup  "), "only the command's own entry");
  assert.match(git(dir, "branch", "--list", "agent/issue-1"), /agent\/issue-1/);
});

for (const flag of ["--help", "-h"]) {
  test(`every command given ${flag} prints help and changes nothing`, () => {
    const dir = project();
    const config = mkdtempSync(join(tmpdir(), "sandcastle-cmdhelp-cfg-"));
    const before = git(dir, "for-each-ref");
    const files = readdirSync(dir).sort();
    for (const command of COMMANDS) {
      const r = cli("src/cli.ts", [command, flag], dir, config);
      assert.equal(r.status, 0, `${command} ${flag}: ${r.stderr}`);
      // `lean-apply` is internal and unlisted, so it gets the whole text.
      assert.match(r.stdout, command === "lean-apply" ? /^ {2}setup /m : new RegExp(`^ {2}${command} `, "m"), `${command} ${flag} prints help`);
    }
    assert.equal(git(dir, "for-each-ref"), before, "no ref changed");
    assert.deepEqual(readdirSync(dir).sort(), files, "no file added to the project");
    assert.deepEqual(readdirSync(config), [], "nothing written to the user's config");
  });
}

test("herdr configure --help, through the plugin's own entry, edits no config", () => {
  const dir = project();
  const config = mkdtempSync(join(tmpdir(), "sandcastle-cmdhelp-cfg-"));
  for (const flag of ["--help", "-h"]) {
    const r = cli("src/herdr-plugin.ts", ["herdr", "configure", flag], dir, config);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /herdr configure \[--remove\]/);
  }
  assert.ok(!existsSync(join(config, "herdr.toml")));
  assert.deepEqual(readdirSync(config), [], "nothing written to the user's config");
});
