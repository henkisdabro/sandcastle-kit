// `sandcastle doctor` for a missing or wrong prerequisite, through shims on PATH: each gets the fix
// for what is actually wrong. Docker or gh absent was told to start an app never installed, a git older
// than 2.31 passed, no git identity passed (git then refused the merges at landing, or guessed an author), and a missing
// GH_TOKEN was reported as "is a fine-grained token". No Docker, no network.
//
//   pnpm test:file test/doctor-prereqs.test.ts

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "sc-prereq-"));
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

// One PATH per case: node, a real git unless shimmed, and the given shims; nothing else of the host's.
const setup = (shims: Record<string, string>, env: Record<string, string> = {}) => {
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
  return {
    cwd: tmp,
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
  };
};
const doctor = (shims: Record<string, string>, env: Record<string, string> = {}) => {
  const r = spawnSync(join(KIT, "bin/sandcastle"), ["doctor"], { ...setup(shims, env), encoding: "utf8" });
  return r.stdout + r.stderr;
};
// Not spawnSync: a server in this process has to answer the doctor's probe while it runs.
const doctorAsync = (shims: Record<string, string>, env: Record<string, string> = {}) =>
  new Promise<string>((done) => {
    const child = spawn(join(KIT, "bin/sandcastle"), ["doctor"], setup(shims, env));
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => done(out));
  });
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

test("no gh: install it; gh signed out: sign in", async () => {
  assert.match(line(doctor({ gh: "#!/bin/sh\nexit 127\n" }), /GitHub CLI/), /^FIX  GitHub CLI installed\n.*(brew install gh|cli\.github\.com)/);
  // GitHub answers (a local stand-in), so the failed `gh auth status` is a sign-in problem.
  const api = createServer((_req, res) => res.end());
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const out = await doctorAsync({ gh: '#!/bin/sh\n[ "$1" = --version ] && exit 0\nexit 1\n' }, { SANDCASTLE_TEST_GITHUB_API: url });
    assert.match(line(out, /GitHub CLI/), /^FIX  GitHub CLI signed in on this machine\n.*`gh auth login`$/);
  } finally {
    api.close();
  }
});

test("gh fails because GitHub is unreachable: check the network, not sign in again", () => {
  // Offline, `gh auth status` calls a good token invalid.
  const out = doctor({ gh: '#!/bin/sh\n[ "$1" = --version ] && exit 0\nexit 1\n' }, { SANDCASTLE_TEST_GITHUB_API: "http://127.0.0.1:9" });
  assert.match(line(out, /GitHub reachable/), /^FIX  GitHub reachable \(gh's sign-in could not be checked\)\n.*Check the network/);
  assert.doesNotMatch(out, /gh auth login/);
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

test("the machine-wide settings line names the file when there is one, and the defaults when there is none", () => {
  const file = join(tmp, "config/sandcastle-kit/config.json");
  writeFileSync(file, "{}");
  assert.match(doctor({}), /ok +machine-wide settings \(\/\S+config\.json, SANDCASTLE_MAX_\*\)/);
  rmSync(file);
  assert.match(doctor({}), /ok +machine-wide settings \(defaults: no \/\S+config\.json, SANDCASTLE_MAX_\*\)/);
  writeFileSync(file, "{}");
});

test("a github-tracker project with no remote is a FIX", () => {
  const root = join(tmp, "no-remote");
  mkdirSync(join(root, ".sandcastle"), { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(join(root, ".sandcastle/config.ts"), 'export default { name: "t", setup: [], gates: [{ name: "ok", command: "true" }] };\n');
  const r = spawnSync(join(KIT, "bin/sandcastle"), ["doctor"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].join(":"), XDG_CONFIG_HOME: join(tmp, "config"), GIT_CEILING_DIRECTORIES: tmp },
  });
  assert.match(r.stdout, /^FIX  a git remote on GitHub \(the github tracker reads its issues\)\n.*git remote add origin/m);
});
