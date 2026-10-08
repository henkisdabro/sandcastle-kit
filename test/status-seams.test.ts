// The status view's rules are light (─ with ┼ ┴ ┬) at every seam, and the bars of one band
// snap onto the bars of the band above when they would land within 4 columns of them: a
// double rule drew a column above stopping on one hairline and the column below starting on
// the other, and a legend sized from its own text left joints like ┴┬ beside the table's.
// A made-up project and a fake `sandcastle` and `docker`; no Docker, no network.
//
//   pnpm test:file test/status-seams.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-seams-"));
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

const render = (cols: number): string => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    env: {
      ...process.env,
      LC_ALL: "C",
      PATH: [FAKE, process.env.PATH].join(":"),
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: String(cols),
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
    encoding: "utf8",
  });
  return r.stdout.replace(/\u001b\[[0-9;]*m/g, "");
};

// Widths where the fixture's cells can all keep their text: in a narrower pane (or with a legend
// that only just fits) a bar stays where it is rather than cut a cell, which is allowed.
const WIDTHS = [80, 100, 110, 120, 130, 150, 170, 180, 200];

for (const cols of WIDTHS) {
  const text = render(cols);
  const lines = text.split("\n").filter((l) => l !== "");
  const rules = lines.filter((l) => /^[┌├└][─┬┴┼]+[┐┤┘]$/.test(l));

  test(`at ${cols} columns every rule is light and as wide as the pane`, () => {
    assert.ok(rules.length >= 5, `only ${rules.length} rules in the view`);
    // No heavy rule or double joint anywhere in the view.
    assert.ok(!/[═╞╡╪╧╤]/.test(text), "a double rule is left in the view");
    for (const l of lines) if (/^[┌├└│]/.test(l)) assert.equal([...l].length, cols, l);
  });

  test(`at ${cols} columns no two joints of a rule are within 4 columns`, () => {
    for (const l of rules) {
      const joints = [...l].flatMap((c, i) => (i > 0 && i < cols - 1 && c !== "─" ? [i] : []));
      for (let k = 1; k < joints.length; k++) {
        assert.ok(joints[k] - joints[k - 1] > 4, `joints ${joints[k - 1]} and ${joints[k]} in ${l}`);
      }
    }
  });
}

test("the status script and the website's demo draw no double rule", () => {
  for (const f of ["status.sh", "site/js/status.js"]) {
    assert.ok(!/[═╞╡╪╧╤]/.test(readFileSync(join(KIT, f), "utf8")), `${f} still has a double rule or joint`);
  }
});
