// The terminal-width and grid helpers the status view draws with: width in cells, cutting, aligning,
// splitting a width and the rule between two rows of cells. Pure string and integer functions, so the
// same frame can be drawn at any width.
//
// Widths are in terminal cells. Colour codes (SGR) and OSC 8 link openers and closers take none,
// a wide (CJK, most emoji) character takes two, a combining character none, and everything else
// one - box drawing included.

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
// A link's opener or closer, ended by ESC \ (the URL can hold any character, an "m" too).
const LINK_CLOSE = `${ESC}]8;;${ESC}\\`;

// The two escapes that take no width: an SGR colour code and an OSC 8 link marker.
// oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern is for
const ESCAPE = /\x1b\]8;[\s\S]*?\x1b\\|\x1b\[[0-9;]*m/y;

// East Asian Wide and Fullwidth blocks that are not emoji presentation (those come from \p{...}).
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u;
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function codePointWidth(cp: number, ch: string): number {
  if (ZERO.test(ch)) return 0;
  if (EMOJI_WIDE.test(ch)) return 2;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

// One user-perceived character: its widest code point, two for an emoji a variation selector
// asks to be drawn as one, and none for a cluster of marks alone.
function graphemeWidth(g: string): number {
  let w = 0;
  for (const ch of g) w = Math.max(w, codePointWidth(ch.codePointAt(0) as number, ch));
  if (w === 1 && g.includes("\u{fe0f}") && PICTOGRAPH.test(g)) return 2;
  return w;
}

type Token = { text: string; width: number; escape: "sgr" | "link" | null };

// The string as escapes (no width) and characters, in order, so a cut can never land inside one.
function* tokens(s: string): Generator<Token> {
  let i = 0;
  let plain = "";
  const flush = function* (): Generator<Token> {
    if (!plain) return;
    for (const { segment } of segmenter.segment(plain)) yield { text: segment, width: graphemeWidth(segment), escape: null };
    plain = "";
  };
  while (i < s.length) {
    if (s[i] === ESC) {
      ESCAPE.lastIndex = i;
      const m = ESCAPE.exec(s);
      if (m) {
        yield* flush();
        yield { text: m[0], width: 0, escape: m[0][1] === "]" ? "link" : "sgr" };
        i += m[0].length;
        continue;
      }
    }
    plain += s[i];
    i++;
  }
  yield* flush();
}

/** Width of `s` in terminal cells. */
export function visibleWidth(s: string): number {
  let n = 0;
  for (const t of tokens(s)) n += t.width;
  return n;
}

/**
 * `s` cut to `width` cells, ending in `…` when it was longer. Never splits an escape or a wide
 * character, and ends a cut that took a colour code with a reset and one that took a link with a
 * link closer, so the rest of the line is not coloured or clickable.
 */
export function fit(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  if (width <= 0) return "";
  const room = width - 1;
  let out = "";
  let n = 0;
  let sgr = false;
  let link = false;
  for (const t of tokens(s)) {
    // Marks that belong to the last character come with it, even at the limit.
    if (t.width === 0 && t.escape === null) {
      out += t.text;
      continue;
    }
    if (n + t.width > room || (t.escape && n >= room)) break;
    out += t.text;
    n += t.width;
    if (t.escape === "sgr") sgr = true;
    if (t.escape === "link") link = true;
  }
  return `${out}${link ? LINK_CLOSE : ""}…${sgr || link ? RESET : ""}`;
}

/**
 * `s` aligned in `width` cells - left, centre or right - and cut with `…` when longer. A centred
 * string puts the odd cell on the right.
 */
export function align(s: string, width: number, how: "l" | "c" | "r" = "l"): string {
  if (width <= 0) return "";
  let w = visibleWidth(s);
  if (w > width) {
    s = fit(s, width);
    w = visibleWidth(s);
  }
  const gap = width - w;
  if (how === "r") return " ".repeat(gap) + s;
  if (how === "c") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

/**
 * `total` cells split by `weights`: each cell's width. Cumulative rounding spreads the remainder
 * over the cells, so the widths always add up to `total`.
 */
export function splitWeights(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const out: number[] = [];
  let cum = 0;
  let prev = 0;
  for (const w of weights) {
    cum += w;
    // `+ 0` turns the -0 a truncated negative leaves into 0.
    const at = Math.trunc((total * cum * 2 + sum) / (sum * 2)) + 0;
    out.push(at - prev);
    prev = at;
  }
  return out;
}

/** The cells of a window `win` wide: its width less the n+1 bars of n cells, split by weights. */
export function splitColumns(win: number, weights: readonly number[]): number[] {
  return splitWeights(win - weights.length - 1, weights);
}

/** The positions of the inner bars between cells of these widths (the window's own edges are 0 and the last column). */
export function barsOf(widths: readonly number[]): number[] {
  const bars: number[] = [];
  let p = 0;
  for (let i = 0; i < widths.length - 1; i++) {
    p += widths[i] + 1;
    bars.push(p);
  }
  return bars;
}

/**
 * A rule across a window `win` wide whose joints meet the bars of the row above (`up`) and below
 * (`down`): `┴` where only the one above has a bar, `┬` where only the one below has, `┼` where
 * both do, `fill` elsewhere. `left` and `right` end it (`├ ┤`, `┌ ┐`, `└ ┘`). Plain text: the
 * caller colours it.
 */
export function junction(win: number, left: string, right: string, fill: string, up: readonly number[], down: readonly number[]): string {
  const above = new Set(up);
  const below = new Set(down);
  let out = "";
  for (let i = 1; i < win - 1; i++) {
    const a = above.has(i);
    const b = below.has(i);
    out += a && b ? "┼" : a ? "┴" : b ? "┬" : fill;
  }
  return left + out + right;
}
