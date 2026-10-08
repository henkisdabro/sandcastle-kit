// The home-path half of test/full-check.sh's outbound scan (`home_paths`): a real home directory
// fails it, a placeholder home does not, and neither does a repo path with a `home` directory in it.
//
//   pnpm test:file test/home-path-scan.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { KIT } from "./cli-spawn.ts";

const root = mkdtempSync(join(tmpdir(), "home-path-scan-"));
after(() => rmSync(root, { recursive: true, force: true }));

// The added lines of a diff, as the scan reads them, and the ones it flags.
function flagged(lines: string[]): string[] {
  const added = join(root, "added.txt");
  writeFileSync(added, lines.map((l) => `+${l}\n`).join(""));
  const script = join(KIT, "test/full-check.sh");
  const r = spawnSync("bash", ["-c", `eval "$(sed -n '/^home_paths()/,/^}/p' "$1")"; home_paths "$2"`, "_", script, added], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\d+:\+/, ""));
}

// Built, not written out: a literal real home in this file would fail the very scan it tests (and
// the pre-commit denylist).
const home = (dir: string, name = "someone") => `/${dir}/${name}`;

test("a real home directory is flagged, on macOS, Linux and WSL", () => {
  const real = [`cd ${home("Users")}/project`, `see ${home("home")}/.config`, `/mnt/c${home("Users")}/x`, `(${home("home")}/x)`];
  assert.deepEqual(flagged(real), real);
});

test("a placeholder home is not", () => {
  assert.deepEqual(flagged(["/home/user/x", "/home/node/.cache", "/home/agent/repo", `${home("Users", "<name>")}/x`]), []);
});

test("a repo path with a home directory in it is not", () => {
  assert.deepEqual(flagged(["site/home/index.html", "tools/home/public/x", "https://example.com/home/page", "my.home/x"]), []);
});
