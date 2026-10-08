// The Herdr plugin's Ctrl-click log popup (the `log` branch of herdr/entry.sh): a log longer
// than the popup opens in less's follow mode with Ctrl-C closing it, a shorter one opens from
// its top line (with Ctrl-C closing it too, once F has started following), and the pager is always the restricted one, with the terminal's own standout for
// its prompt line. A fake `less` on PATH records what it was given; no Herdr, no terminal.
//
//   pnpm test:file test/herdr-log-popup.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = join(fileURLToPath(new URL("..", import.meta.url)), "herdr/entry.sh");
const PAGED = "-Psq closes this popup - F follows new lines (Ctrl-C then closes it)";
const FOLLOWING = "-PwFollowing new lines - Ctrl-C closes this popup";
const dir = mkdtempSync(join(tmpdir(), "sandcastle-log-popup-"));
const fake = `#!/bin/sh\n{ printf '%s\\n' "$@"; printf 'LESSSECURE=%s\\n' "$LESSSECURE"; printf 'so=%s\\n' "\${LESS_TERMCAP_so-unset}"; } > "$FAKE_LESS_OUT"\n`;
// A bin dir of its own keeps the fake out of every other test's PATH.
const makeBin = () => {
  const b = mkdtempSync(join(tmpdir(), "sandcastle-log-popup-bin-"));
  writeFileSync(join(b, "less"), fake);
  chmodSync(join(b, "less"), 0o755);
  return b;
};

// No terminal on stdin, so `stty size` fails and the popup is taken to be 40 rows.
const openLog = (lines: number, extra: Record<string, string> = {}) => {
  const log = join(dir, `log-${lines}.log`);
  writeFileSync(log, Array.from({ length: lines }, (_, i) => `line ${i + 1}\n`).join(""));
  const out = join(dir, `less-${lines}.out`);
  const r = spawnSync("sh", [ENTRY, "log"], {
    env: { ...process.env, PATH: `${makeBin()}${delimiter}${process.env.PATH}`, SANDCASTLE_LOG: log, FAKE_LESS_OUT: out, LESSSECURE: "", LESS_TERMCAP_so: "\x1b[01;44;33m", LESS_TERMCAP_se: "\x1b[0m", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return { args: readFileSync(out, "utf8").trimEnd().split("\n"), log };
};

test("a log longer than the popup follows live, with Ctrl-C closing it", () => {
  const { args, log } = openLog(100);
  assert.deepEqual(args, ["-R", "-X", "-K", PAGED, FOLLOWING, "+F", log, "LESSSECURE=1", "so=unset"]);
});

test("a log shorter than the popup opens from its top line, not followed", () => {
  const { args, log } = openLog(5);
  assert.deepEqual(args, ["-R", "-X", "-K", PAGED, FOLLOWING, log, "LESSSECURE=1", "so=unset"]);
});

test("a log paged from the ticket card says the keys close the log, which goes back to the card", () => {
  const { args, log } = openLog(100, { SANDCASTLE_FROM_CARD: "1" });
  assert.deepEqual(args, ["-R", "-X", "-K", "-Psq closes this log - F follows new lines (Ctrl-C then closes it)", "-PwFollowing new lines - Ctrl-C closes this log", "+F", log, "LESSSECURE=1", "so=unset"]);
});

test("a log exactly as long as the popup is still the short route", () => {
  const { args } = openLog(40);
  assert.ok(!args.includes("+F") && !args.includes("+G"));
});

test("the entry script parses", () => {
  const r = spawnSync("bash", ["-n", ENTRY], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
