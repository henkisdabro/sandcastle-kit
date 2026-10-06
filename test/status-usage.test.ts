// The status view's plan-usage row on a terminal: the bar and the percentage take the band's colour -
// the normal one below 75%, amber from 75%, red from 90% - go grey once the reading is older than 15
// minutes, and carry no colour at all under NO_COLOR. Run on a pty from `script`, as the view's other colour
// checks are (test/no-color.test.ts); the row's text, in each band, is test/status.test.sh's. No Docker, no network.
//
//   node --test test/status-usage.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { kitLikeProcess } from "./kit-process.ts";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-usage-"));
const live = kitLikeProcess();
after(() => {
  live.kill();
  rmSync(TMP, { recursive: true, force: true });
});
const REPO = join(TMP, "repo");
const FAKE = join(TMP, "bin");
mkdirSync(join(REPO, ".sandcastle", "logs"), { recursive: true });
mkdirSync(FAKE);
writeFileSync(join(FAKE, "sandcastle"), "#!/bin/sh\necho '[]'\n");
writeFileSync(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
chmodSync(join(FAKE, "sandcastle"), 0o755);
chmodSync(join(FAKE, "docker"), 0o755);
const git = (...a: string[]) => spawnSync("git", ["-C", REPO, "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");

const now = Math.floor(Date.now() / 1000);
const record = (five: number, week: number, age: number) =>
  writeFileSync(
    join(REPO, ".sandcastle", "logs", "run.json"),
    JSON.stringify({
      orchestrator: "fixture",
      pid: live.pid,
      startedAt: new Date().toISOString(),
      models: "m",
      stage: "running",
      issues: [],
      tickets: {},
      usage: { provider: "claude", at: now - age, windows: { fiveHour: { percent: five, resetsAt: now + 7200 }, week: { percent: week, resetsAt: now + 3 * 86400 } } },
    }),
  );

/** The view's one frame on a pty at 160 columns (the row on one line), with the colour it has. 256 colours: no COLORTERM, so each colour is `ESC[38;5;Nm`. */
const frame = (extra: Record<string, string> = {}) => {
  const cmd = join(KIT, "status.sh");
  const args = process.platform === "linux" ? ["-qec", `bash '${cmd}' 0`, "/dev/null"] : ["-q", "/dev/null", "bash", cmd, "0"];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${FAKE}:${process.env.PATH}`,
    SANDCASTLE_PROJECT: REPO,
    SANDCASTLE_BIN: join(FAKE, "sandcastle"),
    SANDCASTLE_BASE: "main",
    SANDCASTLE_NAME: "fixture",
    TERM_COLS: "160",
    TERM_ROWS: "60",
    XDG_CACHE_HOME: join(TMP, "cache"),
    ...extra,
  };
  delete env.COLORTERM;
  delete env.NO_COLOR;
  Object.assign(env, extra);
  // No stdin: BSD `script` refuses the socket Node passes by default.
  const r = spawnSync("script", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return r.stdout;
};
const hasScript = spawnSync("script", ["--version"], { stdio: "ignore" }).error === undefined;
const skip = hasScript ? false : "script(1) is not installed";

// The view's own colours (status.sh): amber is 221 and red 203; the normal numbers are dry sand (180) and a stale reading damp sand (95).
const AMBER = "\u001b[38;5;221m";
const RED = "\u001b[38;5;203m";
const NORMAL = "\u001b[38;5;180m";
const GREY = "\u001b[38;5;95m";
/** The colour code the pty shows a window's percentage in (`14%`), or undefined when it is not drawn as a whole. */
const coloured = (out: string, text: string) => out.match(new RegExp(`(\\u001b\\[38;5;\\d+m)${text}\\u001b\\[0m`))?.[1];

test("each window is coloured by its own band: normal below 75%, amber from 75%, red from 90%", { skip }, () => {
  record(14, 93, 120);
  let out = frame();
  assert.equal(coloured(out, "14%"), NORMAL, "14% is the normal colour");
  assert.equal(coloured(out, "93%"), RED, "93% is red");
  record(74, 75, 120);
  out = frame();
  assert.equal(coloured(out, "74%"), NORMAL, "74% is still normal");
  assert.equal(coloured(out, "75%"), AMBER, "75% is amber");
  record(89, 90, 120);
  out = frame();
  assert.equal(coloured(out, "89%"), AMBER, "89% is amber");
  assert.equal(coloured(out, "90%"), RED, "90% is red");
});

test("a reading older than 15 minutes is grey, whatever its band, with its age beside it", { skip }, () => {
  record(14, 93, 16 * 60);
  const out = frame();
  assert.equal(coloured(out, "14%"), GREY);
  assert.equal(coloured(out, "93%"), GREY);
  assert.ok(out.includes("(16m ago)"), "the age says how old");
  assert.ok(!out.includes(RED + "▓"), "no red bar");
  // Fresh again the same minute: the band's colour is back.
  record(14, 93, 14 * 60);
  assert.equal(coloured(frame(), "93%"), RED);
});

test("NO_COLOR leaves the row's words and no colour", { skip }, () => {
  record(14, 93, 120);
  const out = frame({ NO_COLOR: "1" });
  assert.ok(out.includes("5h ▓░░░░░░░░░ 14%") && out.includes("93%"), "the row is still drawn");
  assert.ok(!out.includes("\u001b[38;5;"), "colour despite NO_COLOR");
});
