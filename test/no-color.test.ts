// NO_COLOR: the closing summary's plain headings and the status view's colour. No Docker,
// no network, no model: a fake `sandcastle` and a `docker` that finds nothing stand in.
//
//   node --test test/no-color.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Facts, render } from "../src/report.ts";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

const facts: Facts = {
  base: "main",
  tracker: "github",
  started: "2026-09-30T06:41:00.000Z",
  finished: "2026-09-30T08:29:00.000Z",
  live: false,
  dryRun: false,
  tokens: "1M in / 1k out",
  verify: { green: true, line: "ok" },
  gateCount: 1,
  tickets: { "1": { state: "merged", title: "a" } },
  runnable: ["#2"],
  blocked: [],
  standing: [],
  keptWorktrees: [],
  changed: {},
};

test("render(facts, true) drops the emoji from the seven headings and nothing else", () => {
  const plain = render(facts, true);
  const headings = plain.split("\n").filter((l) => l.startsWith("## "));
  const want = [
    "## Run finished",
    "## Done",
    "## Needs you",
    "## Needs fixing (failed or conflicted)",
    "## Runnable now / Still blocked",
    "## Local state",
    "## Next step",
  ];
  assert.equal(headings.length, want.length);
  want.forEach((w, i) => assert.ok(headings[i].startsWith(w), `${headings[i]} should start with ${w}`));
  assert.doesNotMatch(plain, /^## .*[\u{1F300}-\u{1FAFF}☀-➿⏩-⏺️]/mu);
  // The body is untouched: the runnable line keeps its emoji.
  assert.match(plain, /▶️ Runnable now/);
});

test("render(facts) with no second argument keeps the emoji", () => {
  const out = render(facts);
  assert.equal(out, render(facts, false));
  for (const h of ["## 🏁 Run", "## ✅ Done", "## 🙋 Needs you", "## ❌ Needs fixing", "## ▶️ Runnable now / ⏳ Still blocked", "## 📤 Local state", "## 👉 Next step"]) {
    assert.ok(out.includes(h), h);
  }
});

// ---- status.sh -------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "sandcastle-nocolor-"));
const repo = join(tmp, "repo");
const fake = join(tmp, "bin");
mkdirSync(join(repo, ".sandcastle"), { recursive: true });
mkdirSync(fake);
writeFileSync(join(fake, "sandcastle"), "#!/bin/sh\necho '[]'\n");
writeFileSync(join(fake, "docker"), "#!/bin/sh\nexit 1\n");
chmodSync(join(fake, "sandcastle"), 0o755);
chmodSync(join(fake, "docker"), 0o755);
const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");

const env = (extra: Record<string, string> = {}) => {
  const e: NodeJS.ProcessEnv = { ...process.env, PATH: `${fake}:${process.env.PATH}`, SANDCASTLE_PROJECT: repo, ...extra };
  delete e.NO_COLOR;
  return Object.assign(e, extra);
};
const status = (extra: Record<string, string> = {}) => spawnSync("bash", [join(KIT, "status.sh"), "0"], { encoding: "utf8", env: env(extra) });

test("status.sh piped has no colour codes", () => {
  const r = status();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 0);
  assert.ok(!r.stdout.includes("\x1b["), "escape in piped output");
});

test("status.sh piped with NO_COLOR=1 has no colour codes", () => {
  const r = status({ NO_COLOR: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("\x1b["));
});

// On a terminal the view is unchanged unless NO_COLOR is set. `script` gives it a pty; its
// syntax differs between BSD (macOS) and util-linux.
const onPty = (extra: Record<string, string> = {}) => {
  const cmd = join(KIT, "status.sh");
  const args = process.platform === "linux" ? ["-qec", `bash '${cmd}' 0`, "/dev/null"] : ["-q", "/dev/null", "bash", cmd, "0"];
  // No stdin: Node's default is a socket, and BSD script refuses one
  // ("tcgetattr/ioctl: Operation not supported on socket") - util-linux does not mind.
  return spawnSync("script", args, { encoding: "utf8", env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
};
const hasScript = spawnSync("script", ["--version"], { stdio: "ignore" }).error === undefined;

test("status.sh on a terminal keeps colour, and NO_COLOR removes it", { skip: hasScript ? false : "script(1) is not installed" }, () => {
  const coloured = onPty();
  assert.ok(coloured.stdout.includes("\x1b[38;5;"), "no colour on a terminal");
  const plain = onPty({ NO_COLOR: "1" });
  assert.ok(!plain.stdout.includes("\x1b[38;5;"), "colour despite NO_COLOR");
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
