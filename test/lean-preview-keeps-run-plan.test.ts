// `sandcastle lean` reads the green-base record to drop the hook check's unseen-import warning for a hook a passing hook
// test ran cleanly, but it is a preview: the project's lean-plan file is the one a live run's next sandbox applies, so
// the command keys the record with a plan of its own and leaves that file as it found it. Both commands run for real
// against a fake docker; no Docker or network.
//
//   pnpm test:file test/lean-preview-keeps-run-plan.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandcastle-lean-preview-")));
const root = join(dir, "project");
const bin = join(dir, "bin");
mkdirSync(bin);
// The hook check's container (`--entrypoint sh`) reports an unseen import for the one kept hook; every other call -
// the image inspect, a sandbox, the hook test's exec of the hook - succeeds.
writeFileSync(
  join(bin, "docker"),
  `#!/bin/sh
case "$*" in
  *"--entrypoint sh"*) echo "WARN 0 MODULES shared" ;;
  *"sh -c git rev-parse HEAD") git -C "${root}" rev-parse main ;;
  *"timeout 60 sh"*) cat > /dev/null ;;
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
  // Pinned, so resolving the image's versions asks no network.
  CLAUDE_CODE_VERSION: "2.1.285",
  CODEX_VERSION: "0.159.2",
};

const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
mkdirSync(join(root, ".sandcastle"), { recursive: true });
mkdirSync(join(root, ".claude"), { recursive: true });
git("init", "-q", "-b", "main");
git("config", "user.name", "Operator Example");
git("config", "user.email", "operator@example.com");
git("config", "commit.gpgsign", "false");
writeFileSync(join(root, ".gitignore"), ".sandcastle/\n");
writeFileSync(
  join(root, ".sandcastle/config.ts"),
  `export default { name: "fixture", setup: [], gates: [{ name: "test", command: "check-ok" }], hookTests: [{ name: "plain command", tool: "Bash", input: { command: "ls" }, expect: "allow" }] };\n`,
);
writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 solo.py" }] }] } }));
writeFileSync(join(root, "solo.py"), "import shared\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const kit = (...args: string[]) => {
  const r = runKit(args, { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, `sandcastle ${args.join(" ")}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

test("sandcastle lean drops the vouched warning and leaves a live run's plan file as it was", () => {
  assert.match(kit("lean"), /hook warn .*solo\.py - MODULES shared/, "before any hook test passed, the warning stands");
  kit("gates");
  const planFile = join(root, ".sandcastle/.run/lean-plan.json");
  // What a live run started before the config was edited applies to its next sandbox.
  const runs = '{ "hide": [], "write": {}, "items": [], "hooks": [] }';
  writeFileSync(planFile, runs);
  const out = kit("lean");
  assert.doesNotMatch(out, /hook warn/, out);
  assert.equal(readFileSync(planFile, "utf8"), runs);
});
