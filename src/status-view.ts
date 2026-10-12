// The status view in TypeScript (ADR 0003): `status.sh` hands a one-off frame to it when the test switch says
// so (`SANDCASTLE_TEST_STATUS_IMPL=ts`), with the same arguments, environment and exit codes, until it takes
// over (#707). It reads a snapshot (src/status-snapshot.ts), works out the rows (src/status-rows.ts) and draws
// one frame (src/status-render.ts) in a single write.
//
//   status-view.ts [interval] [all|collapse]
//
// One frame and out, whatever the interval, for now: the live view comes later (#705). Exit 0, or 1 when the
// project has no `.sandcastle`, as status.sh's.

import { closeSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { palette, renderFrame } from "./status-render.ts";
import { ticketRows } from "./status-rows.ts";
import { readSnapshot, sandcastleDir } from "./status-snapshot.ts";

const digits = (s: string | undefined): s is string => !!s && /^[0-9]+$/.test(s);

/** The pane's size from its terminal (`stty size`), or undefined without one: a pty that reports 0 0 counts as none. */
const terminalSize = (): { cols: string; rows: string } | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync("/dev/tty", "r");
    const size = spawnSync("stty", ["size"], { stdio: [fd, "pipe", "ignore"], encoding: "utf8" }).stdout?.trim() ?? "";
    const m = /^([1-9][0-9]*) ([1-9][0-9]*)$/.exec(size);
    return m ? { rows: m[1]!, cols: m[2]! } : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const main = (): number => {
  const env = process.env;
  const dir = sandcastleDir(env);
  if (!dir) {
    process.stderr.write(`status: ${resolve(env.SANDCASTLE_PROJECT || process.cwd(), ".sandcastle")}: No such file or directory\n`);
    return 1;
  }
  const [interval = "10", show] = process.argv.slice(2);
  const terminal = !!process.stdout.isTTY;
  // A one-off frame prints every row; a refreshing one fits the pane unless asked for "all". With no terminal any
  // interval prints once, as 0 does.
  const once = interval === "0" || !terminal;
  const showAll = (show || (once ? "all" : "collapse")) === "all";
  // A size given (the tests, the frame checks) wins over the terminal's.
  let cols = env.TERM_COLS;
  let rows = env.TERM_ROWS;
  if (!cols) ({ cols, rows } = terminalSize() ?? { cols, rows });
  if (!digits(cols)) cols = digits(env.COLUMNS) ? env.COLUMNS : String(process.stdout.columns || 100);
  if (!digits(rows)) rows = String(process.stdout.rows || 40);

  const snapshot = readSnapshot(dir, { env, terminal });
  const colours = palette(!env.NO_COLOR && terminal, env.COLORTERM === "truecolor" || env.COLORTERM === "24bit");
  process.stdout.write(renderFrame(snapshot, ticketRows(snapshot), { cols: Number(cols), rows: Number(rows), showAll, colours }));
  return 0;
};

// The exit code without process.exit: a frame written into a pipe is flushed before the process ends.
process.exitCode = main();
