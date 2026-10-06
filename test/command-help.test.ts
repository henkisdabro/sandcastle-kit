// `sandcastle <command> --help` (and `-h`) prints help and changes nothing: `clean --help` once ran
// the clean and deleted the agent branches. A command is run against a temp repo holding a
// merged `agent/issue-1` branch, which must still be there afterwards. No Docker, model calls or
// network.
//
//   node --test test/command-help.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const kit = fileURLToPath(new URL("..", import.meta.url));
// runKit, not bin/sandcastle: it finds `node` on PATH.
const cli = (file: string, args: string[], cwd: string, config: string) =>
  runKit(args, {
    script: join(kit, file),
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: config, XDG_CONFIG_HOME: config, HERDR_CONFIG_PATH: join(config, "herdr.toml"), GIT_CEILING_DIRECTORIES: tmpdir() },
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

test("clean --help prints the clean entry and leaves a merged agent branch alone", () => {
  const dir = project();
  const config = mkdtempSync(join(tmpdir(), "sandcastle-cmdhelp-cfg-"));
  const r = cli("src/cli.ts", ["clean", "--help"], dir, config);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean \[--all\]/);
  assert.ok(!r.stdout.includes("setup  "), "only the command's own entry");
  assert.match(git(dir, "branch", "--list", "agent/issue-1"), /agent\/issue-1/);
});

// One command per flag, spawned: every command's own entry is checked in process, in
// test/command-help-inprocess.test.ts.
for (const flag of ["--help", "-h"]) {
  test(`a command given ${flag} prints help and changes nothing`, () => {
    const dir = project();
    const config = mkdtempSync(join(tmpdir(), "sandcastle-cmdhelp-cfg-"));
    const before = git(dir, "for-each-ref");
    const files = readdirSync(dir).sort();
    const r = cli("src/cli.ts", ["queue", flag], dir, config);
    assert.equal(r.status, 0, `queue ${flag}: ${r.stderr}`);
    assert.match(r.stdout, /^ {2}queue /m, `queue ${flag} prints help`);
    assert.equal(git(dir, "for-each-ref"), before, "no ref changed");
    assert.deepEqual(readdirSync(dir).sort(), files, "no file added to the project");
    assert.deepEqual(readdirSync(config), [], "nothing written to the user's config");
  });
}

test("a help flag after other arguments still prints help and runs nothing", () => {
  const dir = project();
  const config = mkdtempSync(join(tmpdir(), "sandcastle-cmdhelp-cfg-"));
  for (const args of [["run", "170", "--help"], ["requeue", "5", "--note", "-h"], ["clean", "--all", "-h"]]) {
    const r = cli("src/cli.ts", args, dir, config);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^ {2}${args[0]} `, "m"));
  }
  assert.match(git(dir, "branch", "--list", "agent/issue-1"), /agent\/issue-1/);
});

test("the help is the header comment alone, not the code's comments", async () => {
  const { HELP } = await import("../src/help.ts");
  assert.ok(!HELP.join("\n").includes("A refusal the operator acts on"));
  assert.match(HELP.join("\n"), /^ {2}setup /m);
});

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
