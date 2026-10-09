// `pnpm test` runs the status view's scenarios a second time at 180 columns, in the wide header's first
// band (170 up to about 195), where the logo cell once kept 40% of the pane and cut the run, machine and
// model cells. The default 80 and a wide 200 never showed it. No Docker, no network.
//
//   pnpm test:file test/status-wide-band.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const KIT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "sandcastle-status-wide-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const REPO = join(TMP, "repo");
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

// The header's top rule at `cols` columns, colour stripped: its ┬ mark where the cells meet.
const topRule = (cols: number): string => {
  const r = spawnSync(process.env.STATUS_BASH || "bash", [join(KIT, "status.sh"), "0", "all"], {
    encoding: "utf8",
    env: {
      ...process.env,
      LC_ALL: "C.UTF-8",
      PATH: [FAKE, process.env.PATH].join(":"),
      SANDCASTLE_PROJECT: REPO,
      SANDCASTLE_BIN: join(FAKE, "sandcastle"),
      SANDCASTLE_BASE: "main",
      SANDCASTLE_NAME: "fixture",
      TERM_COLS: String(cols),
      TERM_ROWS: "200",
      XDG_CACHE_HOME: join(TMP, "cache"),
    },
    timeout: 60_000,
  });
  const line = r.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.startsWith("┌"));
  assert.ok(line, `no header at ${cols} columns:\n${r.stdout}${r.stderr}`);
  return line;
};

test("pnpm test runs the status view's scenarios at 80 and again at 180 columns", () => {
  const script: string = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8")).scripts.test;
  assert.match(script, /bash test\/status\.test\.sh && COLS=180 bash test\/status\.test\.sh && /);
});

test("the wide header's logo cell is as wide as the logo at any pane width, and the other three share the rest", () => {
  const widths = [170, 180, 200].map((cols) => {
    const cells = [...topRule(cols)].join("").slice(1, -1).split("┬").map((c) => [...c].length);
    assert.equal(cells.length, 4, `four header cells at ${cols} columns`);
    // The run, machine and model cells within the table bars' snap (4 columns) of their fair share.
    const share = (cols - 5 - cells[0]) / 3;
    for (const w of cells.slice(1)) assert.ok(Math.abs(w - share) <= 5, `${cells} at ${cols} columns`);
    return cells[0];
  });
  // 40% of 170 columns was 66; the logo here needs about 50.
  assert.ok(widths[0] < 60, `logo cell ${widths[0]} wide at 170 columns`);
  assert.deepEqual(widths, [widths[0], widths[0], widths[0]], "the logo cell grows with the pane");
});
