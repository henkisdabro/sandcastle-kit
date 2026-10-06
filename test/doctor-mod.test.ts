// `sandcastle doctor` on the Claude Code mod, through a `claude` shim on PATH: silent with no
// Claude Code, the link command when it is not linked, the update when Claude Code is too old to
// load a mod, and Claude Code's own words when it has mods turned off - a linked mod that never
// drew anything gave no hint why. No Docker, no network, no real Claude Code.
//
//   node --test test/doctor-mod.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

// `claude --version` and `claude plugin test`, as the real one answers them.
const claude = (version: string, plugins: string) =>
  `#!/bin/sh\n[ "$1" = --version ] && echo "${version} (Claude Code)" && exit 0\n[ "$1 $2" = "plugin test" ] && echo "claude plugin test: ${plugins}" >&2 && exit 1\nexit 0\n`;
const CAN_LOAD = "no hooks module to load";

const doctor = (shim: string | undefined, linked: boolean) => {
  const home = mkdtempSync(join(tmpdir(), "sc-doctor-mod-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const shims: Record<string, string> = { git: `#!/bin/sh\nexec ${realGit} "$@"\n`, gh: "#!/bin/sh\nexit 0\n", jq: "#!/bin/sh\nexit 0\n", ...(shim ? { claude: shim } : {}) };
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  if (linked) {
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    symlinkSync(join(KIT, "mod"), join(home, ".claude/skills/sandcastle-mod"));
  }
  const r = spawnSync(join(KIT, "bin/sandcastle"), ["doctor"], {
    cwd: home,
    encoding: "utf8",
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: home,
    },
  });
  const lines = (r.stdout + r.stderr).split("\n");
  const at = lines.findIndex((l) => l.includes("Claude Code mod"));
  return at < 0 ? "(missing)" : lines.slice(at, at + 2).join("\n");
};

test("with no Claude Code on PATH the mod is not mentioned", () => {
  assert.equal(doctor(undefined, false), "(missing)");
});

test("not linked: optional, with the link command and what it is", () => {
  const out = doctor(claude("2.1.287", CAN_LOAD), false);
  assert.match(out, /^opt  Claude Code mod \(optional: /);
  assert.match(out, /-> `ln -sfn \S*\/mod ~\/\.claude\/skills\/sandcastle-mod` - it runs inside Claude Code with your permissions/);
  assert.match(out, /`rm ~\/\.claude\/skills\/sandcastle-mod` takes it out\.$/);
});

test("a Claude Code older than 2.1.287 is told to update, linked or not", () => {
  for (const linked of [false, true]) {
    assert.match(doctor(claude("2.1.286", CAN_LOAD), linked), /^opt  Claude Code mod.*\n.*Needs Claude Code 2\.1\.287 or newer \(this is 2\.1\.286\): `claude update`/);
  }
  assert.match(doctor(claude("2.2.0", CAN_LOAD), true), /^ok   Claude Code mod/);
});

test("linked and able to load: ok", () => {
  assert.match(doctor(claude("2.1.287", CAN_LOAD), true), /^ok   Claude Code mod/);
});

test("linked, but Claude Code has mods turned off: its own reason, and what the skill does meanwhile", () => {
  const off = "hooks modules are turned off in this process: the rollout switch served off, and a plugin's tests run only while it is on";
  const out = doctor(claude("2.1.287", off), true);
  assert.match(out, /^opt  Claude Code mod/);
  assert.match(out, /-> Linked, but Claude Code says mods are turned off in this process: the rollout switch served off\. Until they are on again/);
});
