// The website's demo draws with the status view's renderer: site/js/status-render.js is that renderer with
// its types stripped (scripts/site-renderer.mjs, `pnpm site:renderer`), committed because the site has no build
// step. These tests hold the copy to src/, and the demo's frames to the view's.
//
//   pnpm test:file test/site-renderer-copy.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { renderFrame } from "../src/status-render.ts";
import { groupOf, type Table } from "../src/status-rows.ts";
import type { Snapshot } from "../src/status-snapshot.ts";

const KIT = join(import.meta.dirname, "..");
// By a path in a variable: the script is plain JavaScript, with no declarations for the type check.
const { siteRenderer } = (await import(join(KIT, "scripts/site-renderer.mjs"))) as { siteRenderer: () => string };
const site = (file: string) => readFileSync(join(KIT, "site/js", file), "utf8");

type Demo = {
  frame: (t: number, cols: number, changed?: Set<string>) => (string[][] & { key?: string })[];
  ansi: (t: number, cols: number) => string;
  inputs: (t: number) => { snapshot: Snapshot; table: Table };
  toHTML: (lines: unknown) => string;
  clockAt: (t: number) => string;
  colours: any;
  END: number;
};

// The page's scripts in the order index.html loads them, in a context with only a `window`.
const load = (): Demo => {
  const window: Record<string, any> = {};
  const context = vm.createContext({ window });
  vm.runInContext(site("status-render.js"), context, { filename: "status-render.js" });
  vm.runInContext(site("status.js"), context, { filename: "status.js" });
  return window.SandcastleStatus;
};

test("the committed site renderer is what the script writes from src/ now", () => {
  assert.equal(site("status-render.js"), siteRenderer(), "run `pnpm site:renderer` and commit site/js/status-render.js");
});

test("the page loads the renderer's copy before the demo", () => {
  const html = readFileSync(join(KIT, "site/index.html"), "utf8");
  const order = [...html.matchAll(/<script src="js\/([\w-]+\.js)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf("status-render.js") >= 0 && order.indexOf("status-render.js") < order.indexOf("status.js"), order.join(", "));
});

test("the demo keeps no port of the bash grid", () => {
  const demo = site("status.js");
  for (const gone of ["splitW", "snapW", "cellsLine", "function junction", "function align"]) assert.ok(!demo.includes(gone), `${gone} is still in site/js/status.js`);
});

const WIDTHS = [60, 80, 100, 120, 150, 180, 220];
const MINUTES = [0, 2, 8, 13, 22, 28, 31];

test("the demo draws the frames the view draws, for its sample run at every width it offers", () => {
  const demo = load();
  for (const cols of WIDTHS) {
    for (const t of MINUTES) {
      const { snapshot, table } = demo.inputs(t);
      const expected = renderFrame(snapshot, table, { cols, rows: 1000000, showAll: true, colours: demo.colours });
      assert.equal(demo.ansi(t, cols), expected, `minute ${t} at ${cols} columns`);
    }
  }
});

test("the demo's frame is as wide as the pane on every line of the box", () => {
  const demo = load();
  for (const cols of WIDTHS) {
    for (const t of MINUTES) {
      const lines = demo.frame(t, cols).map((segs) => segs.map(([s]) => s).join(""));
      assert.ok(lines.length > 12, `minute ${t} at ${cols} columns drew ${lines.length} lines`);
      for (const l of lines) if (/^[┌├└│]/.test(l)) assert.equal([...l].length, cols, l);
    }
  }
});

test("each ticket row of the demo is in the group the view gives its state word", () => {
  const demo = load();
  const seen = new Set<string>();
  for (const t of Array.from({ length: 63 }, (_, i) => i / 2)) {
    for (const row of demo.inputs(t).table.rows) {
      seen.add(row.state);
      assert.equal(groupOf(row.state), row.group, `${row.state} at minute ${t}`);
    }
  }
  // The demo walks a ticket through the states a night shows.
  for (const state of ["queued", "blocked", "setup", "impl", "review", "gates", "repair", "ready", "landing", "merged", "gate red", "held"]) assert.ok(seen.has(state), `${state} never appears`);
});

test("the header shows the run's clock in the visitor's own zone, and the clock ticks in the same format", () => {
  const zone = process.env.TZ;
  try {
    for (const tz of ["UTC", "Pacific/Auckland", "America/St_Johns"]) {
      process.env.TZ = tz;
      const demo = load();
      const text = demo.frame(8, 120).map((segs) => segs.map(([s]) => s).join("")).join("\n");
      assert.match(text, /22:49:07/, `the clock at minute 8 in ${tz}`);
      assert.equal(demo.clockAt(8), "22:49:07");
      const clock = demo.frame(8, 120).flat().find(([, c]) => /\bclock\b/.test(c));
      assert.equal(clock?.[0], "22:49:07");
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("a ticket that changed state glows in its state cell, and its row carries its id", () => {
  const demo = load();
  const lines = demo.frame(13.5, 120, new Set(["#43"]));
  const row = lines.find((segs) => segs.key === "#43");
  assert.ok(row, "no row for #43");
  assert.ok(row.some(([s, c]) => /flash/.test(c) && s.startsWith("+ merged")), JSON.stringify(row));
  assert.equal(lines.filter((segs) => segs.key === "#43").length, 1);
});

test("the demo's HTML escapes what it draws and names the colours the stylesheet has", () => {
  const demo = load();
  const html = demo.toHTML(demo.frame(10, 100));
  assert.ok(!/<(?!\/?span)/.test(html), "a stray tag in the frame");
  const css = readFileSync(join(KIT, "site/css/site.css"), "utf8");
  for (const name of new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(" ").filter((k) => k !== "ln")))) {
    if (name === "c-clock" || name === "c-flash") continue;
    assert.ok(css.includes(`.${name} `) || css.includes(`.${name},`) || css.includes(`.${name}{`), `site.css has no .${name}`);
  }
});
