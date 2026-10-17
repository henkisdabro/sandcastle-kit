// The status view's rules are light (─ with ┼ ┴ ┬) at every seam, and as wide as the pane: a
// double rule drew a column above stopping on one hairline and the column below starting on
// the other. The bars of one band meet the bars of the band above in one ┼ or stay at least
// 5 columns from them: a near-miss like ┴─┬ reads as a broken grid (#722).
// A made-up project, the status fixtures' live, legacy and ended runs, and fake `sandcastle` and
// `docker`; no Docker, no network.
//
//   pnpm test:file test/status-seams.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildFixture, type FixtureKind } from "./status-fixture.ts";
import { drawFrames, spawnStatus } from "./status-run.ts";

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
  const r = spawnStatus(["0", "all"], {
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

// Panes from the standard 80 columns to a wide one, on both sides of each layout change.
const WIDTHS = [80, 100, 110, 120, 130, 150, 170, 180, 200];

/** The joints of each rule (a lane's title in it included) that lie 1 to 4 columns from the one before. */
const nearMisses = (text: string, cols: number): string[] =>
  text
    .split("\n")
    .filter((l) => /^[┌├└][─┬┴┼ A-Z]+[┐┤┘]$/.test(l))
    .flatMap((l) => {
      const joints = [...l].flatMap((c, i) => (i > 0 && i < cols - 1 && /[┬┴┼]/.test(c) ? [i] : []));
      return joints.flatMap((j, k) => (k > 0 && j - joints[k - 1]! <= 4 ? [`joints ${joints[k - 1]} and ${j} in ${l}`] : []));
    });

for (const cols of WIDTHS) {
  const text = render(cols);
  const lines = text.split("\n").filter((l) => l !== "");
  const rules = lines.filter((l) => /^[┌├└][─┬┴┼]+[┐┤┘]$/.test(l));

  test(`at ${cols} columns no two joints of a rule are within 4 columns`, () => {
    assert.deepEqual(nearMisses(text, cols), []);
  });

  test(`at ${cols} columns every rule is light and as wide as the pane`, () => {
    assert.ok(rules.length >= 5, `only ${rules.length} rules in the view`);
    // No heavy rule or double joint anywhere in the view.
    assert.ok(!/[═╞╡╪╧╤]/.test(text), "a double rule is left in the view");
    for (const l of lines) if (/^[┌├└│]/.test(l)) assert.equal([...l].length, cols, l);
  });
}

// The fixtures fill every lane and every legend group, at the common widths and at each side of the layout's changes.
for (const kind of ["live", "legacy", "ended"] as FixtureKind[]) {
  test(`the ${kind} run's frame has no near-miss joints at the common widths`, () => {
    const fixture = buildFixture(kind, join(TMP, kind));
    try {
      // One reading of the fixture, laid out at each width: the first is also the view's own frame.
      const widths = [80, 72, 83, 100, 110, 120, 132, 135, 148, 154, 160, 165, 200, 210, 240];
      drawFrames(fixture, widths).forEach(({ frame }, i) => assert.deepEqual(nearMisses(frame, widths[i]!), [], `${widths[i]} columns`));
    } finally {
      fixture.stop();
    }
  });
}

test("the status view's renderer and the website's demo draw no double rule", () => {
  for (const f of ["src/status-render.ts", "site/js/status.js"]) {
    assert.ok(!/[═╞╡╪╧╤]/.test(readFileSync(join(KIT, f), "utf8")), `${f} still has a double rule or joint`);
  }
});
