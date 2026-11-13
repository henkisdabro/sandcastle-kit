// The status view's frame: a snapshot (src/status-snapshot.ts) and its rows (src/status-rows.ts), at a pane's
// columns and rows, drawn as lines with the grid helpers (src/status-grid.ts). Pure: no process, no file, no
// clock but the snapshot's.
//
// The layout fits the pane, with no fixed breakpoints: the header is the logo and the lanes (GLOSSARY.md) - run,
// machine, models, settings, plan - beside it while it and three of them fit, else in a row under it, and the
// lanes that do not fit on one summary line. The table's fixed columns have set widths and give way in order in
// a narrow pane; ACTIVITY takes the rest.

import { align, barsOf, fit, junction as rule, splitColumns, splitWeights, visibleWidth } from "./status-grid.ts";
import { CACHE_AMBER, frameFacts, type FrameRow } from "./status-frame.ts";
import type { Row, Table, Tone } from "./status-rows.ts";
import type { Snapshot, SourceName } from "./status-snapshot.ts";

const PALETTE = ["bold", "off", "rule", "mute", "head", "accent", "wht", "grn", "ylw", "cyn", "blu", "gry", "hot", "moon", "dusk", "night", "deep", "star"] as const;
export type Palette = Record<(typeof PALETTE)[number], string>;

/**
 * The view's colours: "sand" - the frame in dark, muted browns and its text in lighter sand, so the state
 * colours, which carry meaning, stand out - 24-bit where the terminal says it has it, else the nearest of the
 * 256. With `colour` false, none: NO_COLOR, or no terminal.
 */
export const palette = (colour: boolean, truecolor: boolean): Palette => {
  if (!colour) return Object.fromEntries(PALETTE.map((k) => [k, ""])) as Palette;
  const sand = (rgb: string, n: number) => (truecolor ? `\x1b[38;2;${rgb}m` : `\x1b[38;5;${n}m`);
  return {
    bold: "\x1b[1m",
    off: "\x1b[0m",
    rule: sand("74;58;42", 58),
    mute: sand("146;124;94", 137),
    head: sand("205;184;148", 180),
    accent: sand("192;164;120", 180),
    wht: sand("232;214;180", 223),
    grn: "\x1b[38;5;77m",
    ylw: "\x1b[38;5;221m",
    cyn: "\x1b[38;5;80m",
    blu: "\x1b[38;5;111m",
    gry: sand("94;78;60", 95),
    hot: "\x1b[38;5;203m",
    moon: sand("232;214;180", 223),
    dusk: sand("205;184;148", 180),
    night: sand("160;134;98", 137),
    deep: sand("112;92;66", 95),
    star: sand("74;58;42", 58),
  };
};

export type FrameOptions = {
  cols: number;
  rows: number;
  /** Every row even past the pane ("all"), or the overflow summarised ("collapse"). */
  showAll: boolean;
  colours: Palette;
};

/**
 * Moves each inner bar of `widths` that lies within 4 columns of a bar of the band above (`refs`) onto it, so
 * the two meet in one ┼ rather than a near-miss like ┴┬; a bar that cannot move onto it without cutting a cell
 * moves away instead, to the nearest column at least 5 from every bar above. `mins` are the least each cell
 * may be (one already narrower keeps its width), and the band still fills the window, the last cell taking the
 * remainder.
 */
export const snap = (widths: number[], refs: number[], mins: number[], win: number): number[] => {
  const n = widths.length;
  const mn = widths.map((w, i) => Math.min(mins[i] ?? 0, w));
  const suf: number[] = Array.from({ length: n + 1 }, () => 0);
  for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1]! + mn[i]! + 1;
  const clear = (q: number) => refs.every((r) => r === q || Math.abs(r - q) > 4);
  const pos: number[] = [];
  let acc = 0;
  let prev = 0;
  for (let i = 0; i < n - 1; i++) {
    acc += widths[i]! + 1;
    const p = acc;
    // Where this bar may go: no cell cut, this one or the later ones.
    const [lo, hi] = [prev + 1 + mn[i]!, win - 1 - suf[i + 1]!];
    const fits = (q: number) => q >= lo && q <= hi;
    const onto = refs.filter((r) => Math.abs(r - p) <= 4 && fits(r)).sort((a, b) => Math.abs(a - p) - Math.abs(b - p))[0];
    let best: number | undefined = onto;
    for (let d = 0; best === undefined && d <= win; d++) best = [p - d, p + d].find((q) => fits(q) && clear(q));
    // Nowhere clear: it stays, unless an earlier move right squeezed this cell.
    pos.push((prev = Math.max(best ?? p, lo)));
  }
  const out: number[] = [];
  prev = 0;
  for (let i = 0; i < n - 1; i++) {
    out.push(pos[i]! - prev - 1);
    prev = pos[i]!;
  }
  out.push(win - 2 - prev);
  return out;
};

/** Whether a bar of one band lies 1 to 4 columns from a bar of the other: a near-miss joint like ┴┬ in the rule between them. */
const nearMiss = (bars: number[], refs: number[]) => bars.some((b) => refs.some((r) => b !== r && Math.abs(b - r) <= 4));

/** Items joined by `sep` into as few lines of `width` cells as they fit. */
export const wrapItems = (width: number, items: string[], sep: string): string[] => {
  const out: string[] = [];
  let line = "";
  for (const item of items) {
    if (!line) line = item;
    else if (visibleWidth(line + sep + item) <= width) line = line + sep + item;
    else {
      out.push(line);
      line = item;
    }
  }
  if (line) out.push(line);
  return out;
};

/** A column of the ticket table. */
type Column = "TICKET" | "STATE" | "TIME" | "DIFF" | "CPU/MEM" | "TOKENS" | "ACTIVITY";

// ACTIVITY is where the notes are: below this width it would cut most of them. STATE at its narrowest keeps its
// glyph and a short word ("! uncommitt…").
const ACTIVITY_MIN = 40;
const STATE_MIN = 11;
const STATE_WIDTH = 15;
// The order the fixed columns give way in when ACTIVITY would fall under its minimum.
const GIVE_WAY: Column[] = ["CPU/MEM", "DIFF", "TOKENS"];

/**
 * The table's columns and their widths, padding included, in a pane `cols` wide whose longest ticket id shown is
 * `longest` cells: the fixed columns at set widths that do not grow with the pane, ACTIVITY the rest.
 */
const tableColumns = (cols: number, longest: number): { name: Column; width: number }[] => {
  const fixed: { name: Column; width: number }[] = [
    { name: "TICKET", width: Math.min(Math.max(longest + 2, 8), 16) },
    { name: "STATE", width: STATE_WIDTH },
    { name: "TIME", width: 9 },
    { name: "DIFF", width: 13 },
    { name: "CPU/MEM", width: 13 },
    { name: "TOKENS", width: 14 },
  ];
  // The bars: one more than the columns, ACTIVITY included.
  const rest = () => cols - fixed.reduce((a, f) => a + f.width, 0) - (fixed.length + 2);
  for (const name of GIVE_WAY) {
    if (rest() >= ACTIVITY_MIN) break;
    fixed.splice(
      fixed.findIndex((f) => f.name === name),
      1,
    );
  }
  const state = fixed.find((f) => f.name === "STATE")!;
  state.width = Math.max(STATE_WIDTH - Math.max(ACTIVITY_MIN - rest(), 0), STATE_MIN);
  return [...fixed, { name: "ACTIVITY", width: Math.max(rest(), 3) }];
};

/** A labelled section of the header (GLOSSARY.md "Lane"): its name, in its top rule, and its three rows. */
type Lane = { name: "RUN" | "MACHINE" | "MODELS" | "SETTINGS" | "PLAN"; /** The name as the top rule draws it, painted. */ title: string; rows: string[] };

/** The cells a lane needs: its widest row with a cell's padding, and room for its title (`─ RUN ─`). */
const laneNeed = (lane: Lane) => Math.max(...lane.rows.map((r) => visibleWidth(r) + 2), lane.name.length + 4);

/** Draws one frame: its lines, each ending in a newline, as `status 0` prints them. */
export const renderFrame = (snapshot: Snapshot, table: Table, { cols, rows, showAll, colours: c }: FrameOptions): string => {
  const { now } = snapshot;
  const WIN = cols;
  const line = (widths: number[], cells: string[], aligns: string[]) =>
    `${c.rule}│${c.off}` + widths.map((w, i) => ` ${align(cells[i] ?? "", w - 2, (aligns[i] ?? "l") as "l" | "c" | "r")} ${c.rule}│${c.off}`).join("");
  const junction = (left: string, right: string, up: number[], down: number[]) => `${c.rule}${rule(WIN, left, right, "─", up, down)}${c.off}`;
  const rep = (ch: string, n: number) => ch.repeat(Math.max(n, 0));
  const dot = `${c.rule} · ${c.off}`;
  // A source that has not answered yet (the live view's first paint) draws as empty, and says so where empty would mislead.
  const loading = (source: SourceName) => snapshot.sources?.[source] === "loading";

  // The collapsing view draws no row for a ticket outside the live run: one line at the foot counts them.
  const listed = !showAll && table.later.ids.length > 0 ? table.rows.filter((r) => r.state !== "later") : table.rows;
  // The table's columns, fitted to what they hold. TICKET fits the longest id shown, not a later run's slug.
  const longest = Math.max(0, ...listed.map((r) => visibleWidth(r.shown)));
  const COLS = tableColumns(cols, longest);
  const TW = COLS.map((col) => col.width);
  const has = (name: Column) => COLS.some((col) => col.name === name);
  // Every column but STATE and ACTIVITY is centred.
  const TAL = COLS.map((col) => (col.name === "STATE" || col.name === "ACTIVITY" ? "l" : "c"));
  const tbars = barsOf(TW);

  // The rows' cells.
  const paint = (tone: Tone) => c[tone];
  const cellsOf = (r: Row): string[] =>
    COLS.map(({ name, width }) => {
      if (name === "TICKET") {
        const id = `${c.bold}${c.wht}${r.shown}${c.off}`;
        return r.link ? `\x1b]8;;file://${r.link}\x1b\\${id}\x1b]8;;\x1b\\` : id;
      }
      if (name === "STATE") return `${paint(r.tone)}${r.glyph} ${r.state}${c.off}`;
      if (name === "TIME") return `${paint(r.timeTone)}${r.time}${c.off}`;
      if (name === "DIFF") {
        const m = /^(\+\S+) (\u2212\S+)$/.exec(r.diff);
        return m ? `${c.grn}${m[1]}${c.off} ${c.hot}${m[2]}${c.off}` : `${c.gry}${r.diff}${c.off}`;
      }
      if (name === "CPU/MEM") return r.cpu ? `${r.cpu.hot ? c.hot : c.head}${r.cpu.cpu}${c.off}${c.head}/${r.cpu.mem}${c.off}` : `${c.gry}-${c.off}`;
      if (name === "TOKENS") {
        if (!r.tokens) return `${c.gry}-${c.off}`;
        // In, the share of it served from cache (amber under 70%), out: `2.5M 94% 27k`. A record without the count shows in/out.
        const [input, output] = r.tokens.split("/");
        if (r.cache === undefined || input === undefined || output === undefined) return `${c.head}${r.tokens}${c.off}`;
        // A ticket past 10M in (`12.3M 94% 85k`) is wider than the cell, whose cut would end in `8…`: the space before
        // out goes, then the share, so no figure is ever cut.
        const share = `${r.cache}%`;
        for (const gap of [" ", ""]) {
          if (input.length + 1 + share.length + gap.length + output.length > width - 2) continue;
          return `${c.head}${input}${c.off} ${r.cache < CACHE_AMBER ? c.ylw : c.head}${share}${c.off}${gap}${c.head}${output}${c.off}`;
        }
        return `${c.head}${r.tokens}${c.off}`;
      }
      return `${paint(r.noteTone)}${r.note}${c.off}`;
    });

  // The castle, the title beside it and the lanes are the frame's facts (src/status-frame.ts), laid out and coloured here.
  const facts = frameFacts(snapshot, table, now);
  const paintRow = (row: FrameRow) =>
    row
      .map((sg) => {
        const code = sg.tone === "plain" ? "" : c[sg.tone];
        return code || sg.bold ? `${sg.bold ? c.bold : ""}${code}${sg.text}${c.off}` : sg.text;
      })
      .join("");
  const logoRows = (n: 3 | 1): string[] => {
    const lg = n === 3 ? facts.logo.map((l, i) => paintRow([...l, ...facts.title.rows[i]!])) : [paintRow(facts.title.compact)];
    // Each padded to the widest, so centring keeps the castle's shape.
    const m = Math.max(...lg.map(visibleWidth));
    return lg.map((l) => align(l, m));
  };

  // The lanes, in priority order: the first that do not fit fold into the summary line.
  const lanes: Lane[] = facts.lanes.map((lane) => ({ name: lane.name, title: paintRow([lane.title]), rows: lane.rows.map(paintRow) }));

  const needs = lanes.map(laneNeed);
  const fits = (widths: number[]) => widths.reduce((a, b) => a + b, 0) + widths.length + 1 <= WIN;

  // A rule whose cells starting at `titles`' columns carry the lane's name: `┬─ RUN ───`.
  const titled = (left: string, right: string, down: number[], titles: { x: number; name: string; title: string }[]) => {
    const plain = rule(WIN, left, right, "─", [], down);
    let out = "";
    let at = 0;
    for (const t of titles) {
      out += `${c.rule}${plain.slice(at, t.x + 2)}${c.off} ${t.title} `;
      at = t.x + 4 + t.name.length;
    }
    return `${out}${c.rule}${plain.slice(at)}${c.off}`;
  };
  // Cells as wide as they need, the spare width shared evenly across the band.
  const spread = (widths: number[]) => {
    const spare = WIN - widths.reduce((a, b) => a + b, 0) - widths.length - 1;
    return splitWeights(spare, widths.map(() => 1)).map((extra, i) => widths[i]! + extra);
  };
  // Each lane's rows on one line, `name  row · row`, the lanes apart by `│`, cut with `…` where the pane ends.
  const summary = (folded: Lane[]) =>
    folded
      .map((lane) => {
        // A row's padding is the band's: one space apart in the line, none leading (after any colour code) and none
        // trailing (a plan reading's blank 5-hour cell would leave `claude  · week`).
        // oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern skips
        const items = lane.rows.map((r) => r.replace(/ {2,}/g, " ").replace(/^((?:\x1b\[[0-9;]*m)*) /, "$1").replace(/ $/, "")).filter((r) => visibleWidth(r) > 0);
        return `${c.mute}${lane.name.toLowerCase()}${c.off}  ${items.join(dot)}`;
      })
      .join(`${c.rule} │ ${c.off}`);

  // An unreadable queue is not an empty one, and neither is one still being read: said under the band.
  const { queueNote } = facts;

  const header = (logo: 3 | 1): { lines: string[]; band: boolean } => {
    const out: string[] = [];
    const LG = logoRows(logo);
    const logoNeed = visibleWidth(LG[0]!) + 2;
    let bars: number[] = [];
    let shown = 0;
    const beside = fits([logoNeed, ...needs.slice(0, Math.min(3, lanes.length))]);
    if (beside) {
      shown = Math.min(3, lanes.length);
      while (shown < lanes.length && fits([logoNeed, ...needs.slice(0, shown + 1)])) shown++;
    } else while (shown < lanes.length && fits(needs.slice(0, shown + 1))) shown++;
    // The lanes' cells, their bars snapped onto the table's. The rule under the lanes meets the table's when no
    // line comes between: a bar that still misses one by a column or few folds the last lane into the summary
    // line, which comes between.
    const cells = (k: number) => (beside ? [logoNeed, ...needs.slice(0, k)] : needs.slice(0, k));
    const place = (k: number) => snap(spread(cells(k)), tbars, cells(k), WIN);
    const meets = (k: number) => k === lanes.length && !queueNote;
    while (shown > 1 && meets(shown) && nearMiss(barsOf(place(shown)), tbars)) shown--;
    if (beside) {
      // Beside the logo: the lanes that fit, in order, after it.
      const widths = place(shown);
      bars = barsOf(widths);
      out.push(titled("┌", "┐", bars, lanes.slice(0, shown).map((lane, i) => ({ x: bars[i]!, name: lane.name, title: lane.title }))));
      const logoAt = logo === 3 ? LG : ["", LG[0]!, ""];
      for (let i = 0; i < 3; i++) out.push(line(widths, [logoAt[i] ?? "", ...lanes.slice(0, shown).map((lane) => lane.rows[i] ?? "")], ["c", ...lanes.map(() => "l")]));
    } else {
      // The logo on a band of its own, the lanes that fit in a row beneath it.
      out.push(junction("┌", "┐", [], []));
      for (const l of LG) out.push(line([WIN - 2], [l], ["c"]));
      if (shown > 0) {
        const widths = place(shown);
        bars = barsOf(widths);
        out.push(titled("├", "┤", bars, lanes.slice(0, shown).map((lane, i) => ({ x: i === 0 ? 0 : bars[i - 1]!, name: lane.name, title: lane.title }))));
        for (let i = 0; i < 3; i++) out.push(line(widths, lanes.slice(0, shown).map((lane) => lane.rows[i] ?? ""), lanes.map(() => "l")));
      }
    }
    const one = [WIN - 2];
    if (shown < lanes.length) {
      out.push(junction("├", "┤", bars, []));
      out.push(line(one, [summary(lanes.slice(shown))], ["l"]));
      bars = [];
    }
    if (queueNote) {
      out.push(junction("├", "┤", bars, []));
      out.push(line(one, [`${c.mute}${queueNote}${c.off}`], ["l"]));
      bars = [];
    }
    // The table's headings, under a light rule: their bold text sets them apart.
    out.push(junction("├", "┤", bars, tbars));
    out.push(line(TW, COLS.map((col) => `${c.bold}${c.head}${col.name}${c.off}`), TAL));
    out.push(junction("├", "┤", tbars, tbars));
    return { lines: out, band: !beside };
  };

  // The legend, each group with its count, then the notes. A group is painted in its first segment's colour, its count bold within it.
  const LEG = facts.legend.groups.map((g) => `${c[g.segments[0]!.tone as keyof Palette]}${g.segments.map((sg) => `${sg.bold ? c.bold : ""}${sg.text}`).join("")}${c.off}`);
  // A note whose column the pane is too narrow to show goes with it.
  const NOTE = facts.legend.notes.filter((note) => !note.column || has(note.column)).map((note) => paintRow(note.segments));

  // Cells as wide as their text needs: every item on one row from 130 columns where they fit (halved until they
  // do), else rows of four, or of two where four do not fit. The legend's bars snap onto the table's, so the seam
  // between them has no near-miss joints; a row whose bars cannot is halved too.
  let per = cols < 130 ? 4 : LEG.length;
  let lw: number[];
  for (;;) {
    const LWT: number[] = [];
    for (let col = 0; col < per; col++) {
      let w = 0;
      for (let r = col; r < LEG.length; r += per) w = Math.max(w, visibleWidth(LEG[r]!));
      LWT.push(w + 4);
    }
    lw = snap(splitColumns(WIN, LWT), tbars, LWT, WIN);
    if (per <= 2 || (LWT.reduce((a, b) => a + b, 0) + per + 1 <= WIN && !nearMiss(barsOf(lw), tbars))) break;
    per = Math.floor((per + 1) / 2);
  }
  const lbars = barsOf(lw);
  const footer: string[] = [];
  for (let r = 0; r < LEG.length; r += per) footer.push(line(lw, LEG.slice(r, r + per), lw.map(() => "c")));
  footer.push(junction("├", "┤", lbars, []));
  const one = splitColumns(WIN, [1]);
  for (const l of wrapItems(WIN - 4, NOTE, `${c.gry} · ${c.off}`)) footer.push(line(one, [l], ["c"]));
  footer.push(junction("└", "┘", [], []));
  // A run started detached writes its output to a log nobody has open: while it is live, its last lines close the frame.
  if (snapshot.runOutput.length) {
    footer.push(`${c.rule}── run output ──${rep("─", WIN > 16 ? WIN - 16 : 0)}${c.off}`);
    for (const l of snapshot.runOutput) footer.push(`${c.mute}${fit(l, WIN)}${c.off}`);
  }

  // A short pane: a logo on a band of its own folds to one row, so the table keeps some rows. Beside the lanes it
  // stays whole: their three rows set the header's height.
  const full = header(3);
  const head = !showAll && full.band && rows - full.lines.length - (footer.length + 1) - 1 < 5 ? header(1).lines : full.lines;

  // The table body.
  const body: string[] = [];
  const sep = junction("├", "┤", tbars, tbars);
  let up = tbars;
  let footHidden = "";
  const shown = listed;
  const laterLine = listed !== table.rows ? `${table.later.ids.length} for a later run (${idRange(table.later.ids)})${table.later.blocked > 0 ? `, ${table.later.blocked} blocked` : ""}` : "";
  if (shown.length === 0) {
    // A project whose merged tickets' logs were archived has had runs; the run cell says how the last one ended.
    const cells: string[] = [];
    cells[TW.length - 1] = `${c.mute}${loading("record") ? "(loading…)" : snapshot.hasRecord ? "(nothing to show)" : "(no runs yet)"}${c.off}`;
    body.push(line(TW, cells, TAL));
  } else {
    // The rows left are the pane less the header, the footer and the bottom row, which stays free. A light rule
    // between groups takes a row too, and the "+N not shown" cell two, only when something is hidden.
    let budget = showAll ? 1000000 : rows - head.length - (footer.length + 1) - 1;
    const reserve = laterLine ? 2 : 0;
    budget = Math.max(budget - reserve, 3);
    let need = 0;
    let pp: number | undefined;
    for (const r of shown) {
      need += 1 + (pp !== undefined && r.prio !== pp ? 1 : 0);
      pp = r.prio;
    }
    if (need > budget) budget -= reserve > 0 ? 1 : 2;
    let used = 0;
    pp = undefined;
    const hidden: Row[] = [];
    for (const r of shown) {
      const gap = pp !== undefined && r.prio !== pp ? 1 : 0;
      if (hidden.length === 0 && used + 1 + gap <= budget) {
        if (gap) body.push(sep);
        body.push(line(TW, cellsOf(r), TAL));
        used += 1 + gap;
        pp = r.prio;
      } else hidden.push(r);
    }
    // What did not fit, by group, so a long queue is one line rather than a screen of rows.
    if (hidden.length) {
      const groups: string[] = [];
      for (const r of hidden) if (!groups.includes(r.group)) groups.push(r.group);
      const parts = groups.map((g) => {
        const ids = hidden.filter((r) => r.group === g).map((r) => r.shown);
        return `${ids.length} ${g} (${idRange(ids)})`;
      });
      footHidden = `${c.gry}+${parts.join(" · ")} not shown${c.off}`;
    }
  }
  if (footHidden || laterLine) {
    body.push(junction("├", "┤", tbars, []));
    for (const l of [footHidden, laterLine ? `${c.gry}${laterLine}${c.off}` : ""]) if (l) body.push(line(one, [l], ["l"]));
    up = [];
  }
  return [...head, ...body, junction("├", "┤", up, lbars), ...footer].map((l) => `${l}\n`).join("");
};

/** Ids as one range when every one is a number ("#101-#140"); else the first three named. */
const idRange = (ids: string[]): string => {
  if (ids.every((id) => /^#[0-9]+$/.test(id))) {
    const nums = ids.map((id) => Number(id.slice(1)));
    const [lo, hi] = [Math.min(...nums), Math.max(...nums)];
    return `#${lo}${hi !== lo ? `-#${hi}` : ""}`;
  }
  return ids.slice(0, 3).join(", ") + (ids.length > 3 ? ", …" : "");
};
