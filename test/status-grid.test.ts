// The status view's terminal-width and grid helpers (src/status-grid.ts), held to the figures the bash view's own
// functions gave (`vlen`, `fit`, `align`, `split_w`, `split_cols` and `junction`, from status.sh before it became a
// wrapper), recorded in test/status-grid-golden.json. Where bash counted characters rather than cells (wide and
// combining characters) the expected cell widths are pinned here instead.
//
//   pnpm test:file test/status-grid.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { align, barsOf, fit, junction, splitColumns, splitWeights, visibleWidth } from "../src/status-grid.ts";

type Golden = {
  out: Record<string, { vlen: number; fit: Record<string, string>; align: Record<string, string> }>;
  split: [number, number[], number[], number[]][];
  junc: [{ win: number; l: string; r: string; up: number[]; down: number[] }, string][];
};
const golden = JSON.parse(readFileSync(join(import.meta.dirname, "status-grid-golden.json"), "utf8")) as Golden;

const red = "\x1b[31m";
const off = "\x1b[0m";
// The bash view closed every cut with its `off`, kept or not; the helper resets only after a cut that
// kept an escape, so a cut of plain text may lack the bash view's trailing reset and nothing else.
function sameAsBash(got: string, want: string, what: string): void {
  if (got === want) return;
  assert.ok(!got.includes("\x1b") && `${got}${off}` === want, `${what}: ${JSON.stringify(got)} vs bash ${JSON.stringify(want)}`);
}
const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

// Strings both implementations count the same: bash counted characters, and these are all one cell.
const SAME: Record<string, string> = {
  ascii: "hello world",
  box: "┌──┬──┐│ x │└──┴──┘",
  colour: `${red}failed${off} 3 of 5`,
  link: `see ${link("https://example.com/a?m=1", "#101")} now`,
  nested: link("https://example.com/x", `${red}#7${off}`),
};

test("visibleWidth: matches the bash vlen for plain, box-drawing, coloured and linked text", () => {
  for (const [name, s] of Object.entries(SAME)) assert.equal(visibleWidth(s), golden.out[name]!.vlen, name);
});

test("visibleWidth: colour codes and link markers have no width", () => {
  assert.equal(visibleWidth(`${red}ab${off}`), 2);
  assert.equal(visibleWidth(link("https://example.com", "abc")), 3);
  assert.equal(visibleWidth(`${red}${link("u", "")}${off}`), 0);
});

test("visibleWidth: wide characters count two, combining characters none", () => {
  assert.equal(visibleWidth("日本語"), 6);
  assert.equal(visibleWidth("a日b"), 4);
  assert.equal(visibleWidth("한국"), 4);
  assert.equal(visibleWidth("ＡＢ"), 4);
  assert.equal(visibleWidth("🚀"), 2);
  assert.equal(visibleWidth("✅ ok"), 5);
  assert.equal(visibleWidth("e\u0301"), 1);
  assert.equal(visibleWidth("cafe\u0301"), 4);
  assert.equal(visibleWidth("👍🏽"), 2);
  assert.equal(visibleWidth("👨\u200d👩\u200d👧"), 2);
  assert.equal(visibleWidth("🇸🇪"), 2);
  assert.equal(visibleWidth("❤\u{fe0f}"), 2);
  assert.equal(visibleWidth("a\u200bb"), 2);
});

test("visibleWidth: box drawing, blocks and the ellipsis count one each", () => {
  for (const ch of ["─", "│", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼", "█", "░", "…", "·"]) assert.equal(visibleWidth(ch), 1, ch);
});

test("fit: matches the bash fit for widths that cut and widths that do not, text that needs no cut returned as it is", () => {
  for (const [name, s] of Object.entries(SAME)) {
    for (const [w, want] of Object.entries(golden.out[name]!.fit)) sameAsBash(fit(s, Number(w)), want, `${name} at ${w}`);
  }
});

test("fit: a cut never leaves a link or a colour open", () => {
  const s = `${red}${link("https://example.com/x", "abcdefghij")}${off} tail`;
  for (let w = 1; w < visibleWidth(s); w++) {
    const out = fit(s, w);
    assert.ok(visibleWidth(out) <= w, `${w}: ${JSON.stringify(out)}`);
    const opens = [...out.matchAll(/\x1b\]8;[^;\x1b]*;[^\x1b]+\x1b\\/g)].length;
    const closes = [...out.matchAll(/\x1b\]8;;\x1b\\/g)].length;
    assert.ok(opens === 0 || closes >= opens, `link open at ${w}: ${JSON.stringify(out)}`);
    if (out.includes(red)) assert.ok(out.endsWith(off), `colour open at ${w}: ${JSON.stringify(out)}`);
  }
});

test("fit: never splits a wide character or drops the mark that belongs to the last one", () => {
  assert.equal(fit("日本語日本語", 7), "日本語…");
  assert.equal(fit("日本語日本語", 6), "日本…");
  assert.equal(visibleWidth(fit("日本語日本語", 6)), 5);
  assert.equal(fit("cafe\u0301 au lait", 5), "cafe\u0301…");
  assert.equal(fit("ab🚀cd", 3), "ab…");
  assert.equal(fit("ab🚀cd", 4), "ab…");
  assert.equal(fit("ab🚀cd", 5), "ab🚀…");
});

test("fit: text that fits is returned unchanged", () => {
  const s = `${red}ok${off}`;
  assert.equal(fit(s, 2), s);
  assert.equal(fit("日本", 4), "日本");
});

test("align: matches the bash align for left, centre and right, padded and cut", () => {
  for (const [name, s] of Object.entries(SAME)) {
    for (const [key, want] of Object.entries(golden.out[name]!.align)) sameAsBash(align(s, Number(key.slice(1)), key[0] as "l" | "c" | "r"), want, `${name} ${key}`);
  }
});

test("align: pads wide text to its cells and fills a width a cut wide character left short", () => {
  assert.equal(align("日本", 6), "日本  ");
  assert.equal(align("日本", 7, "c"), " 日本  ");
  assert.equal(align("日本", 6, "r"), "  日本");
  assert.equal(align("日本語", 6), "日本語");
  assert.equal(align("日本語日", 6), "日本… ");
  assert.equal(align("x", 0), "");
});

test("splitWeights and splitColumns: match the bash split_w and split_cols", () => {
  for (const [total, weights, want, cols] of golden.split) {
    assert.deepEqual(splitWeights(total, weights), want, `${total} by ${weights}`);
    assert.equal(splitWeights(total, weights).reduce((a, b) => a + b, 0), total);
    assert.deepEqual(splitColumns(total, weights), cols, `window ${total} by ${weights}`);
  }
});

test("splitWeights: cells follow the weights and the whole width is used", () => {
  assert.deepEqual(splitWeights(10, [1, 1]), [5, 5]);
  assert.deepEqual(splitWeights(9, [1, 2]), [3, 6]);
  assert.deepEqual(splitWeights(10, [1, 1, 1]), [3, 4, 3]);
  assert.deepEqual(splitColumns(80, [1, 1]), [39, 38]);
  assert.deepEqual(splitWeights(5, []), []);
});

test("barsOf: the inner bars between cells", () => {
  assert.deepEqual(barsOf([38, 39]), [39]);
  assert.deepEqual(barsOf([4, 5, 6]), [5, 11]);
  assert.deepEqual(barsOf([10]), []);
});

test("junction: matches the bash junction where the bars of two rows meet", () => {
  for (const [c, want] of golden.junc) assert.equal(junction(c.win, c.l, c.r, "─", c.up, c.down), want);
});

test("junction: a bar above meets ┴, one below ┬, both ┼", () => {
  assert.equal(junction(11, "├", "┤", "─", [3, 6], [6, 8]), "├──┴──┼─┬─┤");
  assert.equal(junction(8, "└", "┘", "─", [], []), "└──────┘");
});

test("a window of cells drawn between two rules meets bar for bar", () => {
  const win = 41;
  const top = splitColumns(win, [1, 1, 1]);
  const bottom = splitColumns(win, [1, 3]);
  const rule = junction(win, "├", "┤", "─", barsOf(top), barsOf(bottom));
  assert.equal(visibleWidth(rule), win);
  for (const b of barsOf(top)) assert.ok("┴┼".includes(rule[b]));
  for (const b of barsOf(bottom)) assert.ok("┬┼".includes(rule[b]));
});
