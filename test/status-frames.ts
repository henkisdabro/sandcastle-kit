// One snapshot of a project, drawn at several widths: what test/status-run.ts's `drawFrames` runs, with the
// fixture clock preloaded, so a layout test reads the sources once instead of once a width. It draws as
// `status 0 all` does into a pipe (src/status-view.ts) - every row, no colour, the frame whole - and prints the frames as one JSON array. `drawFrames` holds each fixture's first frame to the
// view's own.
//
//   node --import ./test/status-clock.ts test/status-frames.ts ROWS COLS...

import { palette, renderFrame } from "../src/status-render.ts";
import { ticketRows } from "../src/status-rows.ts";
import { readSnapshot, sandcastleDir } from "../src/status-snapshot.ts";

const env = process.env;
const [rows = "400", ...widths] = process.argv.slice(2);
const dir = sandcastleDir(env);
if (!dir) throw new Error("no .sandcastle in SANDCASTLE_PROJECT");
const snapshot = await readSnapshot(dir, { env, terminal: false });
// Into a pipe the view draws no colour, whatever NO_COLOR and COLORTERM say.
const colours = palette(false, false);
const table = ticketRows(snapshot);
process.stdout.write(JSON.stringify(widths.map((cols) => renderFrame(snapshot, table, { cols: Number(cols), rows: Number(rows), showAll: true, colours }))));
