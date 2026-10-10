// `sandcastle doctor`'s machine-wide settings check on the `keepWarm` switch: false (and
// true) pass, any other value is reported with its fix. The session's keep-warm only reads the file, so
// doctor is where a typo is told. No Docker, no network.
//
//   pnpm test:file test/doctor-keep-warm.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const temp = () => mkdtempSync(join(tmpdir(), "sandcastle-keep-warm-"));
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

// This node directly, never bin/sandcastle: see test/settings.test.ts. Shims and a bare
// PATH, as test/doctor-mod.test.ts has them: the machine's own claude, docker and gh would make
// the run slow and reach the network.
const doctor = (settings: string | undefined) => {
  const home = temp();
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries({ git: `#!/bin/sh\nexec ${realGit} "$@"\n`, gh: "#!/bin/sh\nexit 0\n", jq: "#!/bin/sh\nexit 0\n" })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(home, "config");
  if (settings !== undefined) {
    mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
    writeFileSync(join(config, "sandcastle-kit", "config.json"), settings);
  }
  const r = runKit(["doctor"], {
    cwd: home,
    encoding: "utf8",
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: join(home, "cache"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: home,
      CLAUDE_CODE_VERSION: "2.1.0",
      CODEX_VERSION: "0.1.0",
    },
  });
  const out = r.stdout + r.stderr;
  return out.split("\n").filter((l) => l.includes("machine-wide settings") || l.includes("keepWarm")).join("\n");
};

test('"keepWarm": false, true and no value pass', () => {
  for (const settings of ['{"keepWarm": false}', '{"keepWarm": true, "maxGates": 2}', "{}", undefined]) {
    assert.match(doctor(settings), /^ok +machine-wide settings/, String(settings));
  }
});

test("a keepWarm that is not a boolean is reported with its fix", () => {
  for (const value of ['"false"', "0", "null", '"no"']) {
    const out = doctor(`{"keepWarm": ${value}}`);
    assert.match(out, /^FIX +machine-wide settings/, value);
    assert.ok(out.includes(`"keepWarm" in `) && out.includes(`is ${value}, not true or false.`), out);
    assert.match(out, /Set it to `false` to stop the session keeping its prompt cache warm during a run, or delete the line to keep it on\./);
  }
});
