// `sandcastle doctor` for a missing or wrong prerequisite, through shims on PATH: each gets the fix
// for what is actually wrong. Docker or gh absent was told to start an app never installed, a git older
// than 2.31 passed, no git identity passed (git then refused the merges at landing, or guessed an author), and a missing
// GH_TOKEN was reported as "is a fine-grained token". No Docker, no network.
//
//   pnpm exec tsx --test test/doctor-prereqs.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "sc-prereq-"));
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

// One PATH per case: node, a real git unless shimmed, and the given shims; nothing else of the host's.
const doctor = (shims: Record<string, string>, env: Record<string, string> = {}) => {
  const bin = mkdtempSync(join(tmp, "bin-"));
  const all = { git: `#!/bin/sh\nexec ${realGit} "$@"\n`, gh: "#!/bin/sh\nexit 0\n", jq: "#!/bin/sh\nexit 0\n", ...shims };
  for (const [name, body] of Object.entries(all)) {
    if (!body) continue;
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const config = join(tmp, "config");
  mkdirSync(join(config, "sandcastle-kit"), { recursive: true });
  const gitconfig = join(tmp, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = T\n\temail = t@example.com\n");
  const r = spawnSync(join(KIT, "bin/sandcastle"), ["doctor"], {
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
      ...env,
    },
  });
  return r.stdout + r.stderr;
};
const line = (out: string, label: RegExp) => {
  const i = out.split("\n").findIndex((l) => label.test(l));
  return i < 0 ? "(missing)" : out.split("\n").slice(i, i + 2).join("\n");
};

test("no docker at all: install a runtime, not start one", () => {
  // Exit 127, as a shell gives for a missing command: CI runners have a docker in /usr/bin.
  const out = doctor({ docker: "#!/bin/sh\nexit 127\n" });
  assert.match(line(out, /Docker installed/), /^FIX  Docker installed\n.*Install a container runtime|^FIX  Docker installed\n.*Install Docker Engine/);
});

test("docker installed, daemon stopped: start it", () => {
  const out = doctor({ docker: '#!/bin/sh\n[ "$1" = --version ] && echo "Docker version 29" && exit 0\necho "Cannot connect to the Docker daemon" >&2; exit 1\n' });
  assert.match(line(out, /Docker running/), /^FIX  Docker running\n.*Start/);
});

test("no gh: install it; gh signed out: sign in", () => {
  assert.match(line(doctor({ gh: "#!/bin/sh\nexit 127\n" }), /GitHub CLI/), /^FIX  GitHub CLI installed\n.*(brew install gh|cli\.github\.com)/);
  assert.match(line(doctor({ gh: '#!/bin/sh\n[ "$1" = --version ] && exit 0\nexit 1\n' }), /GitHub CLI/), /^FIX  GitHub CLI signed in on this machine\n.*`gh auth login`$/);
});

test("git older than 2.31 is a FIX", () => {
  const out = doctor({ git: `#!/bin/sh\n[ "$1" = --version ] && echo "git version 2.20.1" && exit 0\nexec ${realGit} "$@"\n` });
  assert.match(line(out, /^FIX  git 2\.20/), /git 2\.20 \(2\.31 or newer\)\n.*Install git 2\.31 or newer/);
});

test("no git identity is a FIX with the commands", () => {
  const empty = join(tmp, "empty-gitconfig");
  writeFileSync(empty, "");
  const out = doctor({}, { GIT_CONFIG_GLOBAL: empty });
  assert.match(line(out, /git identity/), /^FIX  git identity.*\n.*git config --global user\.name "Your Name"`, then `git config --global user\.email you@example\.com/);
});

test("a missing GH_TOKEN is reported as missing", () => {
  const out = doctor({});
  assert.match(out, /^FIX  GH_TOKEN set \(a fine-grained token, github_pat_\)$/m);
});

test("a classic GH_TOKEN is reported as classic", () => {
  writeFileSync(join(tmp, "config/sandcastle-kit/.env"), "GH_TOKEN=ghp_classic\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\n");
  const out = doctor({});
  assert.match(out, /^FIX  GH_TOKEN is a fine-grained token \(github_pat_\), not a classic one$/m);
});

test("a credentials file others can read is a FIX with the chmod", () => {
  const env = join(tmp, "config/sandcastle-kit/.env");
  writeFileSync(env, "GH_TOKEN=github_pat_x\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\n");
  chmodSync(env, 0o644);
  assert.match(doctor({}), /^FIX  .*\.env is readable only by you \(mode 644\)\n.*`chmod 600 /m);
  chmodSync(env, 0o600);
  assert.doesNotMatch(doctor({}), /readable only by you/);
});

test("a malformed config.json says so in a sentence", () => {
  const file = join(tmp, "config/sandcastle-kit/config.json");
  writeFileSync(file, '{ "notify": ["x", }');
  assert.match(doctor({}), /is not valid JSON: .*\. Fix the file, or delete it/);
  writeFileSync(file, "{}");
});
