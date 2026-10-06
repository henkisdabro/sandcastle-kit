// `sandcastle doctor` asks Claude Code whether mods are on from an empty directory of its own, and
// removes that directory afterwards: every doctor run once left a `sandcastle-mods-*` directory in
// the temp directory. A `claude` shim on PATH, no Docker, no network, no real Claude Code.
//
//   node --test test/doctor-mods-temp.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { KIT, runKit } from "./cli-spawn.ts";

const home = mkdtempSync(join(tmpdir(), "sc-doctor-mods-temp-"));
after(() => rmSync(home, { recursive: true, force: true }));

test("doctor leaves no directory behind in TMPDIR when it asks Claude Code about mods", () => {
  const bin = join(home, "bin");
  const temp = join(home, "tmp");
  const asked = join(home, "asked");
  mkdirSync(bin);
  mkdirSync(temp);
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const shims: Record<string, string> = {
    git: `#!/bin/sh\nexec ${realGit} "$@"\n`,
    gh: "#!/bin/sh\nexit 0\n",
    jq: "#!/bin/sh\nexit 0\n",
    // Records the directory it was asked from, so the test knows the question was put.
    claude: `#!/bin/sh\n[ "$1" = --version ] && echo "2.1.287 (Claude Code)" && exit 0\n[ "$1 $2" = "plugin test" ] && pwd >${JSON.stringify(asked)} && echo "claude plugin test: no hooks module to load" >&2 && exit 1\nexit 0\n`,
  };
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  // Linked, so doctor asks whether mods are turned off.
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  symlinkSync(join(KIT, "mod"), join(home, ".claude/skills/sandcastle-mod"));
  runKit(["doctor"], {
    cwd: home,
    encoding: "utf8",
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: home,
      TMPDIR: temp,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: home,
    },
  });
  assert.ok(existsSync(asked), "doctor asked Claude Code about mods");
  // Other tools keep their own files there; only the kit's own directories count.
  assert.deepEqual(readdirSync(temp).filter((f) => f.startsWith("sandcastle-")), [], "no sandcastle directory left in TMPDIR");
});
