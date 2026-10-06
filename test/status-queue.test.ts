// The status view when `sandcastle queue` cannot be read: a signed-out gh or a
// stale token must not look like an empty queue, and a view without a working
// jq must say what to install rather than show nothing. A made-up project, a
// fake `sandcastle` and a `docker` that finds nothing; no Docker, no network.
//
//   node --test test/status-queue.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const COLS = 80;
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-queue-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
// A space in the project path, as in the main status test.
const REPO = join(TMP, "my repo");
const FAKE = join(TMP, "bin");
mkdirSync(join(REPO, ".sandcastle", "logs"), { recursive: true });
mkdirSync(FAKE);
const script = (path: string, body: string) => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};
// FAKE_QUEUE_FAIL: the read fails the way a signed-out gh does.
script(join(FAKE, "sandcastle"), `#!/usr/bin/env bash
[ -n "\${FAKE_QUEUE_FAIL:-}" ] && { echo "$FAKE_QUEUE_FAIL" >&2; exit 1; }
printf '['; sep=""
for id in $FAKE_QUEUE; do printf '%s{"id":"%s","title":"t","updated":null,"blockedOn":[]}' "$sep" "$id"; sep=","; done
printf ']\\n'
`);
script(join(FAKE, "docker"), "#!/bin/sh\nexit 1\n");
execFileSync("git", ["-C", REPO, "init", "-q", "-b", "main"]);
execFileSync("git", ["-C", REPO, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);

// A UTF-8 locale, so widths count characters: Linux runners often have only C.UTF-8.
const utf8 = (() => {
  try {
    return execFileSync("locale", ["-a"], { encoding: "utf8" }).split("\n").find((l) => /^(c|en_US)\.utf-?8$/i.test(l));
  } catch {
    return undefined;
  }
})();

const render = (queue: string, env: Record<string, string> = {}, shadow?: string) => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(utf8 ? { LC_ALL: utf8 } : {}),
      PATH: [...(shadow ? [shadow] : []), FAKE, process.env.PATH].join(":"),
      FAKE_QUEUE: queue,
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: String(COLS),
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
      ...env,
    },
  });
  const frame = (r.stdout + r.stderr).replace(/\u001b\[[0-9;]*m/g, "");
  // Nothing wider than the pane: the live view cuts such a line, losing its end.
  for (const line of frame.split("\n")) assert.ok(line.length <= COLS, `wider than ${COLS} columns: ${line}`);
  return { frame, status: r.status };
};

test("a read that works lists the queue and says nothing of a failure", () => {
  const { frame } = render("101");
  assert.match(frame, /^│ +#101 +│ . queued/m);
  assert.doesNotMatch(frame, /queue: could not read/);
});

test("a failed read shows why, and is not shown as an empty queue", () => {
  const { frame } = render("101", { FAKE_QUEUE_FAIL: "gh: not logged in" });
  assert.match(frame, /queue: could not read - gh: not logged in/);
  assert.doesNotMatch(frame, /^│ +#101 +│ . queued/m);
});

test("a long failure message is cut to the pane", () => {
  const { frame } = render("", { FAKE_QUEUE_FAIL: "x".repeat(120) });
  assert.match(frame, /queue: could not read - x+… +│$/m);
});

test("escape codes in the failure message cannot reach the terminal", () => {
  const { frame } = render("", { FAKE_QUEUE_FAIL: "bad\u001b]0;owned\u0007 token" });
  assert.match(frame, /queue: could not read - bad\]0;owned token/);
  assert.doesNotMatch(frame, /\u0007/);
});

test("a jq that does not run stops the view with what to install", () => {
  // On PATH but not running: what a broken install looks like.
  const shadow = join(TMP, "nojq");
  mkdirSync(shadow);
  script(join(shadow, "jq"), "#!/bin/sh\nexit 127\n");
  const { frame, status } = render("101", {}, shadow);
  assert.equal(status, 1);
  assert.match(frame, /status needs jq \(apt install jq \/ brew install jq\)/);
  assert.doesNotMatch(frame, /^│ state /m);
});
