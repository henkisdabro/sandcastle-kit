// The newest release the kit names from its remote (`newestRelease` in src/upgrading.ts), seen through
// `sandcastle --version --json` as a child process: a fake `git` ahead on PATH answers `ls-remote --tags`
// from files, counts its reads and can fail or hang; the cache is a temp XDG_CACHE_HOME. The cache keyed by
// the kit's directory is seen in process, since the child's kit is always this checkout. No network.
//
//   pnpm test:file test/newest-release.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeEach, test } from "node:test";
import { runKit } from "./cli-spawn.ts";

const HOUR = 60 * 60 * 1000;
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const root = mkdtempSync(join(tmpdir(), "sandcastle-newest-"));
const fakeDir = join(root, "fake");
const cacheHome = join(root, "cache");
const configHome = join(root, "config");
mkdirSync(fakeDir);
// The kit directory's own git (`rev-parse`, `remote`) is the real one; only `ls-remote` is answered here.
writeFileSync(
  join(fakeDir, "git"),
  `#!/bin/sh
case " $* " in
  *" ls-remote --get-url origin "*)
    if [ -f "$FAKE_DIR/origin" ]; then cat "$FAKE_DIR/origin"; exit 0; fi ;;
  *" ls-remote --tags origin "*)
    echo "$GIT_TERMINAL_PROMPT|$GIT_SSH_COMMAND" >> "$FAKE_DIR/reads"
    case "$(cat "$FAKE_DIR/mode" 2>/dev/null)" in
      fail) echo "fatal: unable to access" >&2; exit 128 ;;
      hang) exec sleep 60 ;;
    esac
    cat "$FAKE_DIR/tags"; exit 0 ;;
esac
exec ${realGit} "$@"
`,
);
chmodSync(join(fakeDir, "git"), 0o755);

process.env.PATH = [fakeDir, process.env.PATH].join(delimiter);
process.env.FAKE_DIR = fakeDir;
process.env.XDG_CACHE_HOME = cacheHome;
process.env.XDG_CONFIG_HOME = configHome;
process.env.GIT_CEILING_DIRECTORIES = tmpdir();
const { newestRelease, NEWEST_FRESH_MS } = await import("../src/upgrading.ts");

const tags = (...names: string[]) => writeFileSync(join(fakeDir, "tags"), names.map((n, i) => `${String(i).padStart(40, "a")}\trefs/tags/${n}\n`).join(""));
const mode = (m: "fail" | "hang" | "") => writeFileSync(join(fakeDir, "mode"), m);
const origin = (url: string) => writeFileSync(join(fakeDir, "origin"), `${url}\n`);
const reads = () => {
  try {
    return readFileSync(join(fakeDir, "reads"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const settings = (json: string) => {
  mkdirSync(join(configHome, "sandcastle-kit"), { recursive: true });
  writeFileSync(join(configHome, "sandcastle-kit", "config.json"), json);
};
const cacheFiles = () => {
  const dir = join(cacheHome, "sandcastle-kit", "newest-release");
  return readdirSync(dir).map((f) => join(dir, f));
};
/** Ages every cached answer by `ms`, as if the read happened that long ago. */
const age = (ms: number) => {
  for (const file of cacheFiles()) {
    const c = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...c, at: c.at - ms }));
  }
};

beforeEach(() => {
  for (const name of ["reads", "mode", "tags"]) rmSync(join(fakeDir, name), { force: true });
  rmSync(cacheHome, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  origin("https://example.invalid/kit-a.git");
  tags("v0.1.0");
});

/** `sandcastle --version --json`'s `newestRelease`, from a directory that is no project. */
const newest = (extra: { json?: boolean } = {}) => {
  const cwd = mkdtempSync(join(root, "cwd-"));
  const r = runKit(extra.json === false ? ["--version"] : ["--version", "--json"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return extra.json === false ? r.stdout : JSON.parse(r.stdout).newestRelease;
};

test("the highest exact vX.Y.Z tag wins, by number: pre-releases, other names and an annotated tag's peeled line are no extra release", () => {
  tags("v0.9.0", "v0.10.0", "v0.10.0^{}", "v0.11.0-rc.1", "v1", "v1.2", "release-2.0.0", "vX.Y.Z", "latest", "v0.10.1", "v0.10.1^{}", "v0.9.9");
  const out = newest();
  assert.equal(out.release, "0.10.1");
  assert.ok(Math.abs(Date.parse(out.checkedAt) - Date.now()) < 60_000, out.checkedAt);
  assert.equal(new Date(out.checkedAt).toISOString(), out.checkedAt);
});

test("a remote with no release tag gives null", () => {
  tags("v0.11.0-rc.1", "latest", "v1.0");
  assert.equal(newest(), null);
  assert.equal(reads().length, 1);
});

test("the read never prompts: no terminal prompt and ssh in batch mode", () => {
  newest();
  const [line] = reads();
  assert.match(line!, /^0\|.*ssh.* -o BatchMode=yes$/);
});

test("a second call within six hours reads no remote and answers the same", () => {
  tags("v0.2.0");
  const first = newest();
  tags("v0.3.0");
  age(NEWEST_FRESH_MS - 60_000);
  const again = newest();
  assert.equal(again.release, "0.2.0");
  // checkedAt is when the remote was read, not when the cache was looked at.
  assert.equal(Date.parse(first.checkedAt) - Date.parse(again.checkedAt), NEWEST_FRESH_MS - 60_000);
  assert.equal(reads().length, 1);
});

test("after six hours the remote is read again", () => {
  tags("v0.2.0");
  assert.equal(newest().release, "0.2.0");
  tags("v0.2.0", "v0.3.0");
  age(NEWEST_FRESH_MS + 60_000);
  assert.equal(newest().release, "0.3.0");
  assert.equal(reads().length, 2);
});

test("a failure gives null and is not retried within the hour, even when the remote is back", () => {
  mode("fail");
  assert.equal(newest(), null);
  mode("");
  tags("v0.2.0");
  age(HOUR - 60_000);
  assert.equal(newest(), null);
  assert.equal(reads().length, 1);
  age(2 * 60_000);
  assert.equal(newest().release, "0.2.0");
  assert.equal(reads().length, 2);
});

test("after a failure the answer is unknown, never the last good release", () => {
  tags("v0.2.0");
  assert.equal(newest().release, "0.2.0");
  age(NEWEST_FRESH_MS + 60_000);
  mode("fail");
  assert.equal(newest(), null);
  mode("");
  assert.equal(newest(), null);
});

test("a hanging remote is killed within the bound and gives null", () => {
  mode("hang");
  const started = Date.now();
  assert.equal(newest(), null);
  const took = Date.now() - started;
  assert.ok(took >= 9_000 && took < 25_000, `took ${took} ms`);
});

test("a changed origin shares no answer with the one before it, and the first is still held", () => {
  tags("v0.5.0");
  assert.equal(newest().release, "0.5.0");
  origin("https://example.invalid/kit-b.git");
  tags("v0.6.0");
  assert.equal(newest().release, "0.6.0");
  assert.equal(reads().length, 2);
  origin("https://example.invalid/kit-a.git");
  assert.equal(newest().release, "0.5.0");
  assert.equal(reads().length, 2);
});

test("two kit directories with one origin share no answer", () => {
  rmSync(join(fakeDir, "origin"));
  const kit = () => {
    const dir = mkdtempSync(join(root, "kit-"));
    spawnSync(realGit, ["-C", dir, "init", "-q"]);
    spawnSync(realGit, ["-C", dir, "remote", "add", "origin", "https://example.invalid/kit.git"]);
    return dir;
  };
  const [a, b] = [kit(), kit()];
  tags("v0.5.0");
  assert.equal(newestRelease(a)?.release, "0.5.0");
  tags("v0.6.0");
  assert.equal(newestRelease(b)?.release, "0.6.0");
  assert.equal(newestRelease(a)?.release, "0.5.0");
  assert.equal(reads().length, 2);
});

test("a kit with no origin remote gives null and reads nothing", () => {
  rmSync(join(fakeDir, "origin"));
  const dir = mkdtempSync(join(root, "kit-"));
  spawnSync(realGit, ["-C", dir, "init", "-q"]);
  assert.equal(newestRelease(dir), null);
  assert.equal(reads().length, 0);
});

test("a corrupt cache counts as none: the remote is read again", () => {
  tags("v0.2.0");
  newest();
  for (const bad of ["", "not json", "null", "[]", JSON.stringify({ at: "now", ok: true, release: "0.9.0" }), JSON.stringify({ at: Date.now(), ok: true, release: "banana" }), JSON.stringify({ at: Date.now(), release: "0.9.0" })]) {
    for (const file of cacheFiles()) writeFileSync(file, bad);
    const reading = reads().length;
    assert.equal(newest().release, "0.2.0", bad);
    assert.equal(reads().length, reading + 1, bad);
  }
});

test('"updateCheck": false reads nothing and gives null, a cached answer included', () => {
  tags("v0.2.0");
  assert.equal(newest().release, "0.2.0");
  settings('{"updateCheck": false}');
  assert.equal(newest(), null);
  assert.equal(reads().length, 1);
  rmSync(cacheHome, { recursive: true });
  assert.equal(newest(), null);
  assert.equal(reads().length, 1);
});

test('only "updateCheck": false stops the read: true and a value doctor reports leave it on', () => {
  for (const value of ["true", '"no"', "0"]) {
    rmSync(cacheHome, { recursive: true, force: true });
    settings(`{"updateCheck": ${value}}`);
    tags("v0.2.0");
    assert.equal(newest().release, "0.2.0", value);
  }
});

test("plain --version reads no remote", () => {
  assert.match(newest({ json: false }), /^sandcastle-kit \d+\.\d+\.\d+/);
  assert.equal(reads().length, 0);
});
