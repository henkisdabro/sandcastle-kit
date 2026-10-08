// `sandcastle gates` rewrites the lean-plan and green-base files a live run's sandboxes and verify read, and its own `.git`
// check reads the run's commits as tampering, so it takes the run lock as `land` and `clean` do: beside a live run it
// refuses before it opens a sandbox. Run for real against a fake docker that logs each call; no Docker or network.
//
//   pnpm test:file test/gates-beside-live-run.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";
import { kitLikeProcess } from "./kit-process.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-gates-live-")));
const root = join(dir, "project");
const bin = join(dir, "bin");
const dockerLog = join(dir, "docker.log");
mkdirSync(bin);
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh
echo "$*" >> "${dockerLog}"
case "$*" in
  *"sh -c git rev-parse HEAD") git -C "${root}" rev-parse main ;;
esac
exit 0
`,
);
chmodSync(join(bin, "docker"), 0o755);
mkdirSync(join(dir, "config/sandcastle-kit"), { recursive: true });
writeFileSync(join(dir, "config/sandcastle-kit/.env"), "CLAUDE_CODE_OAUTH_TOKEN=made-up\nGH_TOKEN=github_pat_made-up\n");
const env = {
  ...process.env,
  PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
  XDG_CACHE_HOME: join(dir, "cache"),
  XDG_CONFIG_HOME: join(dir, "config"),
  CLAUDE_CODE_VERSION: "2.1.285",
  CODEX_VERSION: "0.159.2",
};

const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
mkdirSync(join(root, ".sandcastle/.run"), { recursive: true });
mkdirSync(join(root, ".sandcastle/logs"), { recursive: true });
git("init", "-q", "-b", "main");
git("config", "user.name", "Operator Example");
git("config", "user.email", "operator@example.com");
git("config", "commit.gpgsign", "false");
writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
writeFileSync(join(root, ".sandcastle/config.ts"), `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "check-ok" }] };\n`);
git("add", "-A");
git("commit", "-q", "-m", "init");

const lockFile = join(root, ".sandcastle/logs/run.lock");
const planFile = join(root, ".sandcastle/.run/lean-plan.json");
const gates = () => runKit(["gates"], { cwd: root, env, encoding: "utf8" });

test("sandcastle gates refuses beside a live run, leaving its plan file alone and opening no sandbox", () => {
  const plan = '{ "hide": [], "write": {}, "items": [], "hooks": [] }';
  writeFileSync(planFile, plan);
  const live = kitLikeProcess();
  try {
    writeFileSync(lockFile, `${live.pid} made-up-token fixture\n`);
    const r = gates();
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /Another sandcastle run of this project is live/);
    assert.equal(readFileSync(planFile, "utf8"), plan);
    assert.equal(existsSync(dockerLog), false, "docker was called");
  } finally {
    live.kill();
  }
});

test("sandcastle gates with no run live passes and leaves no run lock behind", () => {
  execFileSync("rm", ["-f", lockFile]);
  const r = gates();
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(existsSync(lockFile), false);
});
