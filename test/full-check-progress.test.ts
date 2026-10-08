// What test/full-check.sh shows while it runs: the log directory first, then each leg's name, ok or
// FAIL and seconds on stderr as the leg ends (not in the summary's fixed order), then the summary
// and the RESULT: line. Run against a copy of the script with stub helpers and a fake `pnpm` (no
// suite, no Docker), under the host's bash and under macOS's 3.2 where this sandbox has it.
//
//   pnpm test:file test/full-check-progress.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT } from "./cli-spawn.ts";

const root = mkdtempSync(join(tmpdir(), "full-check-progress-"));
after(() => rmSync(root, { recursive: true, force: true }));

// A checkout with the script, the real shard count helper, a suite that takes a second only under
// the agent's committer identity (so that leg ends last), a `pnpm` whose tsc fails, and a quiet
// `gitleaks`, so the scan leg neither depends on this machine's nor races the slow leg.
mkdirSync(join(root, "test"));
mkdirSync(join(root, "bin"));
copyFileSync(join(KIT, "test/full-check.sh"), join(root, "test/full-check.sh"));
copyFileSync(join(KIT, "test/shard-count.sh"), join(root, "test/shard-count.sh"));
writeFileSync(join(root, "test/status.test.sh"), "exit 0\n");
writeFileSync(join(root, "test/run-shards.sh"), '[ -z "${GIT_COMMITTER_NAME:-}" ] || sleep 1\necho "ℹ pass 1"\n');
writeFileSync(join(root, "bin/pnpm"), "#!/bin/sh\nexit 1\n");
chmodSync(join(root, "bin/pnpm"), 0o755);
writeFileSync(join(root, "bin/gitleaks"), "#!/bin/sh\nexit 0\n");
chmodSync(join(root, "bin/gitleaks"), 0o755);
const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git("init", "-q");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");

const shells = ["bash", ...(spawnSync("bash32", ["--version"], { stdio: "ignore" }).error ? [] : ["bash32"])];
for (const shell of shells) {
  test(`${shell}: the log directory comes first and each leg reports as it ends`, () => {
    // Without an identity of its own, so that only the agent leg (which sets one) is slow.
    const { GIT_COMMITTER_NAME: _name, GIT_COMMITTER_EMAIL: _email, ...inherited } = process.env;
    const r = spawnSync(shell, ["test/full-check.sh", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...inherited, NO_DOCKER: "1", PATH: `${join(root, "bin")}:${inherited.PATH}`, XDG_CONFIG_HOME: join(root, "xdg") },
    });
    const lines = r.stderr.split("\n").filter(Boolean);
    assert.match(lines[0]!, /^logs: \S+$/);
    const legs = lines.slice(1).map((l) => l.replace(/ \(\d+s\)$/, ""));
    assert.ok(lines.slice(1).every((l) => / \(\d+s\)$/.test(l)), r.stderr);
    // macOS runs a leg more: the status view under its own bash 3.2.
    const wants = ["types: FAIL", "view: ok", "tests: ok", "agent: ok", "scan: ok", ...(process.platform === "darwin" ? ["bash32: ok"] : [])];
    for (const want of wants) {
      assert.ok(legs.some((l) => l.startsWith(want)), `${want} in ${r.stderr}`);
    }
    assert.equal(legs.length, wants.length, r.stderr);
    assert.equal(legs.at(-1), "agent: ok", "the slow leg reports last, not in the summary's order");
    assert.equal(r.stdout.trimEnd().split("\n").at(-1), "RESULT: FAIL");
    assert.match(r.stdout, /^== (Linux|Darwin)\n(tsc: FAIL\n)/m);
    assert.ok(r.stdout.indexOf("tsc: FAIL") < r.stdout.indexOf("pnpm test: "), "the summary keeps its fixed order");
  });
}
