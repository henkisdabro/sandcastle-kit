// `sandcastle doctor` asks nothing of jq: the status view is TypeScript and reads its records itself, so a machine
// without jq (here a `jq` first on PATH that does not run, which is as good as none) gets no FIX or mention
// of it. No Docker, no network.
//
//   pnpm test:file test/doctor-no-jq.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const tmp = mkdtempSync(join(tmpdir(), "sc-nojq-"));
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

test("doctor on a machine without jq lists no jq check and asks for none", () => {
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  // Exit 127, as a shell gives for a missing command: CI runners have a jq in /usr/bin.
  for (const [name, body] of Object.entries({ git: `#!/bin/sh\nexec ${realGit} "$@"\n`, gh: "#!/bin/sh\nexit 0\n", jq: "#!/bin/sh\nexit 127\n" })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(tmp, "config");
  mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
  const gitconfig = join(tmp, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = T\n\temail = t@example.com\n");
  const r = runKit(["doctor"], {
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
  const out = r.stdout + r.stderr;
  assert.match(out, /^ok +git /m, "doctor ran its checks");
  assert.doesNotMatch(out, /\bjq\b/);
});
