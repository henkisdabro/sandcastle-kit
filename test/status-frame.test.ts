// The status view's frame lines are valid UTF-8: each `─` is the three bytes
// e2 94 80. GNU tr maps bytes, so `tr ' ' '─'` on Linux wrote a bare e2 per
// column; BSD tr on macOS is multibyte-aware and hid it. Checked in a UTF-8
// and in the C locale, as the line is built by bash, not by the locale.
// A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm exec tsx --test test/status-frame.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const COLS = 80;
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-frame-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const REPO = join(TMP, "my repo");
const FAKE = join(TMP, "bin");
mkdirSync(join(REPO, ".sandcastle", "logs"), { recursive: true });
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
script(join(FAKE, "sandcastle"), "#!/usr/bin/env bash\nprintf '[]\\n'\n");
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
execFileSync("git", ["-C", REPO, "init", "-q", "-b", "main"]);
execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);

const utf8 = (() => {
  try {
    return execFileSync("locale", ["-a"], { encoding: "utf8" }).split("\n").find((l) => /^(c|en_US)\.utf-?8$/i.test(l));
  } catch {
    return undefined;
  }
})();

const render = (locale: string): Buffer => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    env: {
      ...process.env,
      LC_ALL: locale,
      PATH: [FAKE, process.env.PATH].join(":"),
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: String(COLS),
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
  });
  return r.stdout;
};

for (const locale of [utf8, "C"]) {
  if (!locale) continue;
  test(`frame lines are whole ─ characters in the ${locale} locale`, () => {
    const out = render(locale);
    // Strict decoding throws on a bare e2.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(out).replace(/\u001b\[[0-9;]*m/g, "");
    // The window's rules: an end, ─ or ═ with the joints, the other end - each the pane's width.
    const frames = text.split("\n").filter((l) => /^[┌├╞└][─═┬┴┼╤╧╪]+[┐┤╡┘]$/.test(l));
    assert.ok(frames.length > 0, "no frame line in the view");
    for (const l of frames) assert.equal([...l].length, COLS, l);
    assert.ok(out.includes(Buffer.from([0xe2, 0x94, 0x80])), "no ─ as e2 94 80");
  });
}
