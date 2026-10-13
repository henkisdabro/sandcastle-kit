// `sandcastle doctor` and the kit's newest release: an `info` line when the remote tags a release newer
// than the kit's, nothing otherwise, and the machine-wide settings check on `updateCheck`. A fake `git`
// answers `ls-remote` from a variable; shims and a bare PATH as test/doctor-idle-mark.test.ts has them.
// No Docker, no network.
//
//   pnpm test:file test/doctor-newest-release.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const temp = () => mkdtempSync(join(tmpdir(), "sandcastle-doctor-newest-"));
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const RELEASE = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")).version as string;

const doctor = (tag: string | undefined, settings?: string) => {
  const home = temp();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const fakeGit = [
    "#!/bin/sh",
    'case " $* " in',
    '  *" ls-remote --get-url origin "*) echo https://example.invalid/kit.git; exit 0 ;;',
    `  *" ls-remote --tags origin "*) ${tag === undefined ? "exit 128" : `printf '%s\\trefs/tags/%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ${tag}; exit 0`} ;;`,
    "esac",
    `exec ${realGit} "$@"`,
    "",
  ].join("\n");
  for (const [name, body] of Object.entries({ git: fakeGit, gh: "#!/bin/sh\nexit 0\n", jq: "#!/bin/sh\nexit 0\n" })) {
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
  return (r.stdout + r.stderr).split("\n");
};

const lines = (out: string[], word: string) => out.filter((l) => l.includes(word)).join("\n");

test("a release newer than the kit's is named in an info line with the way to update", () => {
  const out = doctor("v999.0.0");
  assert.match(lines(out, "is out"), new RegExp(`^info +sandcastle-kit 999\\.0\\.0 is out \\(this kit is ${RELEASE.replaceAll(".", "\\.")}\\).*/sandcastle update`));
});

test("nothing is said when the newest release is the kit's own, an older one, none, or the read failed", () => {
  for (const tag of [`v${RELEASE}`, "v0.0.1", "v999.0.0-rc.1", "latest", undefined]) {
    assert.equal(lines(doctor(tag), "is out"), "", String(tag));
  }
});

test('"updateCheck": false stops the lookup: no line even with a newer release', () => {
  assert.equal(lines(doctor("v999.0.0", '{"updateCheck": false}'), "is out"), "");
});

test("an updateCheck that is not a boolean is reported with its fix, and true passes", () => {
  assert.match(lines(doctor("v0.0.1", '{"updateCheck": true}'), "machine-wide settings"), /^ok +machine-wide settings/);
  for (const value of ['"false"', "0", "null", '"no"']) {
    const out = lines(doctor("v0.0.1", `{"updateCheck": ${value}}`), "updateCheck");
    assert.ok(out.includes(`"updateCheck" in `) && out.includes(`is ${value}, not true or false.`), out);
    assert.match(out, /Set it to `false` to stop doctor and the idle mark looking up the kit's newest release/);
  }
  assert.match(lines(doctor("v0.0.1", '{"updateCheck": "no"}'), "machine-wide settings"), /^FIX +machine-wide settings/);
});
