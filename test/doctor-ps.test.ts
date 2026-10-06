// `sandcastle doctor` on a Linux host with no working `ps` (procps missing, as on slim server images):
// the status view's `run_alive` reads every live run as ended there, so doctor names the package.
// On macOS `ps` is part of the system and doctor says nothing about it. The platform is set in the
// child by a preload, so both cases run on either host. No Docker, no network.
//
//   node --test test/doctor-ps.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CLI, runNode } from "./cli-spawn.ts";

const tmp = mkdtempSync(join(tmpdir(), "sc-doctor-ps-"));
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

const preload = (platform: NodeJS.Platform) => {
  const file = join(tmp, `platform-${platform}.mjs`);
  writeFileSync(file, `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`);
  return file;
};

// Shims ahead of the host's own tools on PATH; `ps` exits 127, as a shell does for a missing command.
const doctor = (platform: NodeJS.Platform, ps: string) => {
  const bin = mkdtempSync(join(tmp, "bin-"));
  const shims = { git: `#!/bin/sh\nexec ${realGit} "$@"\n`, gh: "#!/bin/sh\nexit 0\n", jq: "#!/bin/sh\nexit 0\n", docker: "#!/bin/sh\nexit 127\n", ps };
  for (const [name, body] of Object.entries(shims)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(tmp, "config");
  mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
  const gitconfig = join(tmp, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = T\n\temail = t@example.com\n");
  const r = runNode(["--import", preload(platform), CLI, "doctor"], {
    cwd: tmp,
    encoding: "utf8",
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: tmp,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: join(tmp, "cache"),
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: tmp,
    },
  });
  return r.stdout + r.stderr;
};

const missing = "#!/bin/sh\nexit 127\n";
const working = '#!/bin/sh\necho "node src/cli.ts doctor"\n';

test("on Linux with no working ps, doctor gives a FIX naming procps", () => {
  assert.match(doctor("linux", missing), /^FIX  ps \(status view\)\n\s+-> .*procps/m);
});

test("on Linux with a working ps, doctor's ps line is ok", () => {
  const out = doctor("linux", working);
  assert.match(out, /^ok   ps \(status view\)$/m);
  assert.doesNotMatch(out, /procps/);
});

test("on macOS doctor says nothing about ps, even with none on PATH", () => {
  const out = doctor("darwin", missing);
  assert.match(out, /^ok   Node /m, "doctor ran");
  assert.doesNotMatch(out, /\bps \(status view\)|procps/);
});
