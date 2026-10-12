// The status view's terminal-width and grid helpers (src/status-grid.ts), held to status.sh's own
// functions: each case runs the bash `vlen`, `fit`, `align`, `split_w`, `split_cols` and `junction`
// on the same input and compares. Where bash counts characters rather than cells (wide and
// combining characters) the expected cell widths are pinned here instead.
//
//   pnpm test:file test/status-grid.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { align, barsOf, fit, junction, splitColumns, splitWeights, visibleWidth } from "../src/status-grid.ts";

const STATUS = join(import.meta.dirname, "..", "status.sh");

// Bash counts characters only in a UTF-8 locale; status.sh picks one the same way.
const locale = (() => {
  try {
    return execFileSync("locale", ["-a"], { encoding: "utf8" }).split("\n").find((l) => /^(c|en_US)\.utf-?8$/i.test(l)) ?? "en_US.UTF-8";
  } catch {
    return "en_US.UTF-8";
  }
})();

const FUNCTIONS = ["vstrip", "fit", "vlen", "align", "split_w", "split_cols", "junction"];

// Runs `body` with status.sh's functions defined (read out with eval "$(sed ...)", as bash 3.2
// needs) and the colour variables set as a coloured view has them. Arguments arrive as $1...
function bash(body: string, args: string[], off = "\x1b[0m"): string {
  const defs = FUNCTIONS.map((f) => `eval "$(sed -n '/^${f}() {/,/^}/p' "$STATUS")"`).join("\n");
  const r = spawnSync("bash", ["-c", `ESC=$'\\e'; ST=$'\\e\\\\'; rule=''; off=$2; STATUS=$1; shift 2\n${defs}\n${body}`, "bash", STATUS, off, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: locale },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const red = "\x1b[31m";
const bold = "\x1b[1;38;5;208m";
const off = "\x1b[0m";
// The bash view closes every cut with its `off`, kept or not; the helper resets only after a cut that
// kept an escape, so a cut of plain text may lack the bash view's trailing reset and nothing else.
function sameAsBash(got: string, want: string, what: string): void {
  if (got === want) return;
  assert.ok(!got.includes("\x1b") && `${got}${off}` === want, `${what}: ${JSON.stringify(got)} vs bash ${JSON.stringify(want)}`);
}
const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

// Strings both implementations count the same: bash counts characters, and these are all one cell.
const SAME: Record<string, string> = {
  empty: "",
  ascii: "hello world",
  spaces: "  a  b  ",
  "box drawing": "┌──┬──┐│ x │└──┴──┘",
  "block and gauge": "█████░ 5/6",
  accents: "café ñ",
  colour: `${red}failed${off} 3 of 5`,
  "colour with several parameters": `${bold}RUN${off}`,
  link: `see ${link("https://example.com/a?m=1", "#101")} now`,
  "link with an m in its url": link("https://example.com/m/m", "ticket"),
  "colour inside a link": link("https://example.com/x", `${red}#7${off}`),
  "only escapes": `${red}${off}`,
  "lone escape": "a\x1bb",
};

test("visibleWidth: matches the bash vlen for plain, box-drawing, coloured and linked text", () => {
  for (const [name, s] of Object.entries(SAME)) {
    const want = Number(bash(`vlen "$1"; printf '%s' "$VN"`, [s]));
    // A lone ESC is a character to bash and no cell to a terminal; every other case must agree.
    if (name === "lone escape") continue;
    assert.equal(visibleWidth(s), want, name);
  }
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
  assert.equal(visibleWidth("é"), 1);
  assert.equal(visibleWidth("café"), 4);
  assert.equal(visibleWidth("👍🏽"), 2);
  assert.equal(visibleWidth("👨‍👩‍👧"), 2);
  assert.equal(visibleWidth("🇸🇪"), 2);
  assert.equal(visibleWidth("❤️"), 2);
  assert.equal(visibleWidth("a​b"), 2);
});

test("visibleWidth: box drawing, blocks and the ellipsis count one each", () => {
  for (const ch of ["─", "│", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼", "█", "░", "…", "·"]) assert.equal(visibleWidth(ch), 1, ch);
});

test("fit: matches the bash fit for every width, with text that needs no cut returned as it is", () => {
  for (const [name, s] of Object.entries(SAME)) {
    if (name === "lone escape") continue;
    for (let w = 1; w <= visibleWidth(s) + 2; w++) {
      const want = bash(`fit "$1" "$2"; printf '%s' "$FIT"`, [s, String(w)]);
      sameAsBash(fit(s, w), want, `${name} at ${w}`);
    }
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
  assert.equal(fit("café au lait", 5), "café…");
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
    if (name === "lone escape") continue;
    for (const how of ["l", "c", "r"] as const) {
      for (const w of [1, 4, 9, 14, 30]) {
        const want = bash(`align "$1" "$2" "$3"; printf '%s' "$REPLY"`, [s, String(w), how]);
        sameAsBash(align(s, w, how), want, `${name} ${how} at ${w}`);
      }
    }
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
  const cases: Array<[number, number[]]> = [
    [100, [1, 1, 1]],
    [97, [3, 2, 5]],
    [80, [1]],
    [79, [2, 1, 1, 3, 1]],
    [10, [1, 1, 1, 1, 1, 1, 1]],
    [0, [1, 2]],
    [183, [4, 1, 1, 2]],
  ];
  for (const [total, weights] of cases) {
    const want = bash(`split_w "$@"; printf '%s ' "\${OW[@]}"`, [String(total), ...weights.map(String)]).trim().split(" ").map(Number);
    assert.deepEqual(splitWeights(total, weights), want, `${total} by ${weights}`);
    assert.equal(splitWeights(total, weights).reduce((a, b) => a + b, 0), total);
    const cols = bash(`WIN=$1; shift; split_cols "$@"; printf '%s ' "\${OW[@]}"`, [String(total), ...weights.map(String)]).trim().split(" ").map(Number);
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
  const cases: Array<{ win: number; l: string; r: string; up: number[]; down: number[] }> = [
    { win: 20, l: "├", r: "┤", up: [5, 12], down: [5, 9] },
    { win: 20, l: "┌", r: "┐", up: [], down: [7] },
    { win: 20, l: "└", r: "┘", up: [3, 10, 18], down: [] },
    { win: 12, l: "├", r: "┤", up: [], down: [] },
    { win: 30, l: "├", r: "┤", up: [10, 20], down: [10, 20] },
  ];
  for (const c of cases) {
    const want = bash(`WIN=$1; junction "$2" "$3" ─ "$4" "$5"; printf '%s' "$REPLY"`, [String(c.win), c.l, c.r, c.up.join(" "), c.down.join(" ")], "");
    assert.equal(junction(c.win, c.l, c.r, "─", c.up, c.down), want);
  }
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
