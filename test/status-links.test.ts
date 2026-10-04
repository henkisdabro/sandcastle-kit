// The status view's ticket links and its ctrl-click hint, on a terminal: inside Herdr they
// are emitted only once `sandcastle herdr configure` has left its marker under the kit's cache
// (no marker, no plugin, so a click would do nothing), and SANDCASTLE_LINKS overrides all of
// it. The pipe cases are in test/status.test.sh; only a pty from `script` reaches the marker
// check. No Docker, no network, no model calls.
//
//   pnpm exec tsx --test test/status-links.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-links-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const REPO = join(TMP, "repo");
const FAKE = join(TMP, "bin");
const CACHE = join(TMP, "cache");
const MARKER = join(CACHE, "sandcastle-kit", "herdr-plugin-linked");
mkdirSync(join(REPO, ".sandcastle/logs"), { recursive: true });
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
script(join(FAKE, "sandcastle"), `#!/bin/sh\necho '[{"id":"101","title":"t","updated":null,"blockedOn":[]}]'\n`);
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
const git = (...a: string[]) => spawnSync("git", ["-C", REPO, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
git("branch", "agent/issue-101");
writeFileSync(join(REPO, ".sandcastle/logs/agent-issue-101-implement-101.log"), "working\n");

const wrapper = join(TMP, "wrapper.sh");
script(wrapper, `#!/bin/sh\nbash "${join(KIT, "status.sh")}" 0 all\n`);

// util-linux and BSD `script` differ in syntax; no stdin, as BSD refuses Node's socket.
const view = (env: Record<string, string>) => {
  const args = process.platform === "linux" ? ["-qec", `sh '${wrapper}'`, "/dev/null"] : ["-q", "/dev/null", "sh", wrapper];
  const r = spawnSync("script", args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, SANDCASTLE_PROJECT: REPO, SANDCASTLE_BASE: "main", TERM_COLS: "100", TERM_ROWS: "200", XDG_CACHE_HOME: CACHE, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  assert.ok(r.stdout.includes("#101"), `no ticket row drawn: ${r.stdout}${r.stderr}`);
  return { linked: r.stdout.includes("\x1b]8;;file://"), hint: r.stdout.includes("ctrl-click a ticket for its log") };
};
const hasScript = spawnSync("script", ["--version"], { stdio: "ignore" }).error === undefined;
const opts = { skip: hasScript ? false : "script(1) is not installed" };

test("inside Herdr with no plugin marker: no links, no hint", opts, () => {
  rmSync(MARKER, { force: true });
  assert.deepEqual(view({ HERDR_ENV: "1" }), { linked: false, hint: false });
});

test("inside Herdr with the plugin marker: links and the hint", opts, () => {
  mkdirSync(join(CACHE, "sandcastle-kit"), { recursive: true });
  writeFileSync(MARKER, "");
  assert.deepEqual(view({ HERDR_ENV: "1" }), { linked: true, hint: true });
});

test("outside Herdr a marker changes nothing, and SANDCASTLE_LINKS overrides it all", opts, () => {
  mkdirSync(join(CACHE, "sandcastle-kit"), { recursive: true });
  writeFileSync(MARKER, "");
  assert.deepEqual(view({}), { linked: false, hint: false });
  assert.deepEqual(view({ HERDR_ENV: "1", SANDCASTLE_LINKS: "0" }), { linked: false, hint: false });
  rmSync(MARKER, { force: true });
  assert.deepEqual(view({ SANDCASTLE_LINKS: "1" }), { linked: true, hint: true });
});
