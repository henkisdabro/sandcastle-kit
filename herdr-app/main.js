// sandcastle: a project's status view as a native pane of the Herdr app (#957), with what the terminal view shows.
//
// One model of the view, two renderers: `sandcastle status --json --frame` prints the terminal view's own facts - the
// table (`ticketRows`, src/status-rows.ts) and the frame (`frameFacts`, src/status-frame.ts: the castle, the title,
// the lanes, the legend and the queue note) as segments of text and palette tone names - and this mod lays them out
// in the app's theme. It decides nothing about a ticket itself: a row says what it says in the terminal.
//
// The layout is the terminal's, in cells of the monospace font: the lanes beside the castle while it and three of
// them fit, else under it; the lanes that do not fit fold into one summary line, cut with `…`; the table's fixed
// columns give way (CPU/MEM, DIFF, TOKENS) before ACTIVITY falls under 40 cells, and ACTIVITY is cut with `…`.
// Where the terminal hides rows a short pane cannot hold, the pane scrolls instead.
//
// Liveness (#871): `watchFolder` on `.sandcastle/logs` wakes a read when `run.json` or `outcomes.json` changes (the
// agents' logs change constantly, and would read back to back), with `--no-queue` (no tracker call); a 15 s timer
// reads everything, the queue included. One read at a time, at most one every 2 s. A `--no-queue` table keeps, from
// the last full read, every row it lacks (the contract in `Table.queueRead`).
//
// Props: `project` (the project root; default: the focused pane's folder when the pane opens) and `command` (the
// argv that prints the facts; default `sandcastle status --json --frame`; a test points it at a fixture's wrapper).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, watchFolder, theme, props, focused, settings } from "herdr";

const DEFAULT_COMMAND = ["sandcastle", "status", "--json", "--frame"];
// Git, Docker and the queue change without a write the wake sees: read everything this often regardless.
const FULL_MS = 15_000;
// The least time between two reads' starts: a read is a Node process (and a `gh` call on a full read).
const GAP_MS = 2_000;
// The records that change a row's state; the agents' logs beside them are written all the time.
const WAKES = new Set(["run.json", "outcomes.json"]);

// The mod draws in the terminals' monospace font at their size, so a cell is the width of a terminal's and the
// terminal view's layout rules give the same layout at the same pane width. JetBrains Mono (Herdr's default) is 0.6 em wide.
const FONT = "JetBrains Mono";
let SIZE = 14;
let CELL = SIZE * 0.6;
const PAD = 10;

// The table's columns, as src/status-render.ts sets them.
const ACTIVITY_MIN = 40;
const STATE_MIN = 11;
const STATE_WIDTH = 15;
const GIVE_WAY = ["CPU/MEM", "DIFF", "TOKENS"];
// A cache share under this is amber (CACHE_AMBER in src/status-frame.ts; the TOKENS note says the figure).
const CACHE_AMBER = 70;

const width = (text) => [...text].length;
const rowWidth = (row) => row.reduce((n, s) => n + width(s.text), 0);
const two = (n) => String(n).padStart(2, "0");
const clockNow = () => {
  const d = new Date();
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/** The palette's tone names (src/status-render.ts `palette`) as theme colours; the castle keeps its sand. */
const colours = (t, dark) => {
  const castle = dark
    ? { moon: "#e8d6b4", dusk: "#cdb894", night: "#a08662", deep: "#705c42", star: "#6b5a44" }
    : { moon: "#8a6a40", dusk: "#a5875e", night: "#b39670", deep: "#6e5638", star: "#c4ae8a" };
  return {
    plain: t.foreground, head: t.foreground, wht: t.foreground, accent: t.accent, mute: t.muted, gry: t.dim, rule: t.dim,
    grn: t.ansi2, ylw: t.ansi3, cyn: t.ansi6, blu: t.ansi4, hot: t.ansi1, ...castle,
  };
};

/** The table's columns and their widths in cells, bars included, for a pane `cols` wide (tableColumns in src/status-render.ts). */
const tableColumns = (cols, longest) => {
  const fixed = [
    { name: "TICKET", width: Math.min(Math.max(longest + 2, 8), 16) },
    { name: "STATE", width: STATE_WIDTH },
    { name: "TIME", width: 9 },
    { name: "DIFF", width: 13 },
    { name: "CPU/MEM", width: 13 },
    { name: "TOKENS", width: 14 },
  ];
  const rest = () => cols - fixed.reduce((a, f) => a + f.width, 0) - (fixed.length + 2);
  for (const name of GIVE_WAY) {
    if (rest() >= ACTIVITY_MIN) break;
    fixed.splice(fixed.findIndex((f) => f.name === name), 1);
  }
  const state = fixed.find((f) => f.name === "STATE");
  state.width = Math.max(STATE_WIDTH - Math.max(ACTIVITY_MIN - rest(), 0), STATE_MIN);
  return [...fixed, { name: "ACTIVITY", width: Math.max(rest(), 3) }];
};

/** A row's text with runs of spaces as one, none leading or trailing: a lane row as the summary line has it. */
const squeeze = (row) => {
  const out = [];
  let space = true;
  for (const s of row) {
    let text = "";
    for (const ch of s.text) {
      if (ch === " " && space) continue;
      space = ch === " ";
      text += ch;
    }
    if (text) out.push({ ...s, text });
  }
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/ +$/, "");
  return out.filter((s) => s.text);
};

/** A row cut to `n` cells, its last cell `…` when it was longer. */
const cut = (row, n) => {
  if (rowWidth(row) <= n) return row;
  const out = [];
  let left = n - 1;
  for (const s of row) {
    if (left <= 0) break;
    const chars = [...s.text];
    out.push({ ...s, text: chars.slice(0, left).join("") });
    left -= Math.min(chars.length, left);
  }
  out.push({ text: "…", tone: "gry" });
  return out;
};

/** Items joined by `sep` into as few lines of `n` cells as they fit (wrapItems in src/status-render.ts). */
const wrapItems = (n, items, sep) => {
  const out = [];
  let line = null;
  for (const item of items) {
    if (!line) line = item;
    else if (rowWidth(line) + rowWidth(sep) + rowWidth(item) <= n) line = [...line, ...sep, ...item];
    else {
      out.push(line);
      line = item;
    }
  }
  if (line) out.push(line);
  return out;
};

/** Ids as one range when every one is a number ("#101-#140"); else the first three named. */
const idRange = (ids) => {
  if (ids.every((id) => /^#[0-9]+$/.test(id))) {
    const nums = ids.map((id) => Number(id.slice(1)));
    const [lo, hi] = [Math.min(...nums), Math.max(...nums)];
    return `#${lo}${hi !== lo ? `-#${hi}` : ""}`;
  }
  return ids.slice(0, 3).join(", ") + (ids.length > 3 ? ", …" : "");
};

/** The table's order (sortRows in src/status-rows.ts). */
const sortRows = (rows) => {
  const num = (id) => Number(/^\d+/.exec(id)?.[0] ?? 0);
  return [...rows].sort((a, b) => a.prio - b.prio || b.key - a.key || num(a.id) - num(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** A `--no-queue` table with the rows of the last full read it lacks, counted as `ticketRows` counts them. */
const withQueueRows = (fresh, full) => {
  const have = new Set(fresh.rows.map((r) => r.id));
  const kept = full.rows.filter((r) => !have.has(r.id));
  const counts = { ...fresh.counts };
  const later = { ids: [...fresh.later.ids], blocked: fresh.later.blocked };
  for (const r of kept) {
    if (r.state === "later") {
      later.ids.push(r.shown);
      if (r.note.startsWith("waits for ")) later.blocked++;
      counts.later++;
    } else if (!r.apart) counts[r.group]++;
  }
  return { ...fresh, rows: sortRows([...fresh.rows, ...kept]), counts, later };
};

export default class SandcastleStatus extends View {
  init(_props, cx) {
    // The project is fixed when the pane opens: a later focus elsewhere must not turn it into another project's view.
    this.root = props()?.project || focused()?.cwd || "";
    this.doc = null; // the last good reading, `{ table, frame }`
    this.full = null; // the last full read (the queue included)
    this.error = "";
    this.readAt = "";
    this.cost = null;
    this.cols = 120;
    this.want = "full";
    this.wake = null;
    this.lastStart = 0;

    cx.spawn(async (cx) => this.reader(cx));
    cx.timer.every(FULL_MS, () => this.request("full"));
    // The clock in the title counts as the terminal's does.
    cx.timer.every(1000, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      const logs = `${this.root}/.sandcastle/logs`;
      for (;;) {
        let paths;
        try {
          paths = await watchFolder(logs);
        } catch {
          return; // no logs folder yet: the full read's timer still runs
        }
        // A returned root means "anything may have changed".
        if (paths.some((p) => p === logs || WAKES.has(p.split("/").pop()))) this.request("logs");
        await cx.sleep(50); // ends this loop when a newer build of the mod replaces this one
      }
    });
  }

  /** Asks for a read: a full one wins over a log-driven one asked at the same time. */
  request(kind) {
    if (this.want !== "full") this.want = kind;
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    }
  }

  async reader(cx) {
    for (;;) {
      if (!this.want) await new Promise((resolve) => (this.wake = resolve));
      const gap = this.lastStart + GAP_MS - Date.now();
      if (gap > 0) await cx.sleep(gap);
      const kind = this.want;
      this.want = null;
      this.lastStart = Date.now();
      await this.read(kind);
      cx.notify();
    }
  }

  async read(kind) {
    const [cmd, ...args] = props()?.command ?? DEFAULT_COMMAND;
    const started = Date.now();
    try {
      const r = await exec(cmd, kind === "logs" ? [...args, "--no-queue"] : args, { cwd: this.root, timeout: 60_000 });
      if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
      const doc = JSON.parse(r.stdout);
      if (!doc?.table || !doc?.frame) throw new Error("no frame in the reading: a kit older than 0.25.0?");
      if (doc.table.queueRead === false && this.full) {
        doc.table = withQueueRows(doc.table, this.full.table);
        // A skipped queue says nothing; the last full read's note (a queue that could not be read) still holds.
        doc.frame.queueNote = this.full.frame.queueNote;
      } else if (doc.table.queueRead !== false) this.full = doc;
      this.doc = doc;
      this.error = "";
      this.readAt = clockNow();
      this.cost = Date.now() - started;
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
  }

  // ---- drawing ----

  segs(c, row) {
    return h_flex().flex_none().whitespace_nowrap().children(
      row.map((s) => div().flex_none().text_color(c[s.tone] ?? c.plain).when(Boolean(s.bold), (el) => el.font_bold()).child(s.text)),
    );
  }

  /** The clock segment shows this machine's time now, as the terminal's view redraws it each second. */
  ticking(row, clock) {
    return row.map((s) => (s.text === clock && s.tone === "accent" ? { ...s, text: clockNow() } : s));
  }

  header(t, c, frame, table, cols) {
    const title = frame.title;
    const logoRows = frame.logo.map((l, i) => [...l, ...this.ticking(title.rows[i] ?? [], title.clock)]);
    const logoNeed = Math.max(...logoRows.map(rowWidth)) + 2;
    const lanes = frame.lanes;
    const needs = lanes.map((l) => Math.max(...l.rows.map((r) => rowWidth(r) + 2), l.name.length + 4));
    const fits = (ws) => ws.reduce((a, b) => a + b, 0) + ws.length + 1 <= cols;
    let shown = 0;
    const beside = fits([logoNeed, ...needs.slice(0, Math.min(3, lanes.length))]);
    if (beside) {
      shown = Math.min(3, lanes.length);
      while (shown < lanes.length && fits([logoNeed, ...needs.slice(0, shown + 1)])) shown++;
    } else while (shown < lanes.length && fits(needs.slice(0, shown + 1))) shown++;

    // The rows start together and the block is centred, as the terminal pads each to the widest: the castle keeps its shape.
    const castle = v_flex().justify_center().items_center().py(4).child(v_flex().children(logoRows.map((r) => this.segs(c, r))));
    const lane = (l, need, first) =>
      v_flex().flex_1().min_w(need * CELL).px(CELL).py(2).when(!first, (el) => el.border_l(1).border_color(t.border))
        .child(this.segs(c, [l.title]))
        .children([0, 1, 2].map((i) => this.segs(c, l.rows[i]?.length ? l.rows[i] : [{ text: " ", tone: "plain" }])));
    const parts = [];
    if (beside) {
      parts.push(h_flex().items_stretch()
        .child(castle.flex_1().min_w(logoNeed * CELL))
        .children(lanes.slice(0, shown).map((l, i) => lane(l, needs[i], false))));
    } else {
      parts.push(castle.w_full());
      if (shown > 0) parts.push(h_flex().items_stretch().border_t(1).border_color(t.border).children(lanes.slice(0, shown).map((l, i) => lane(l, needs[i], i === 0))));
    }
    // The lanes that did not fit: one line, each lane's name then its rows, cut where the pane ends.
    if (shown < lanes.length) {
      const sum = lanes.slice(shown).flatMap((l, i) => [
        ...(i > 0 ? [{ text: " │ ", tone: "rule" }] : []),
        { text: `${l.name.toLowerCase()}  `, tone: "mute" },
        ...l.rows.map(squeeze).filter((r) => r.length).flatMap((r, j) => (j > 0 ? [{ text: " · ", tone: "rule" }, ...r] : r)),
      ]);
      parts.push(div().px(CELL).py(2).border_t(1).border_color(t.border).child(this.segs(c, cut(sum, cols - 4))));
    }
    if (frame.queueNote) parts.push(div().px(CELL).py(2).border_t(1).border_color(t.border).child(this.segs(c, cut([{ text: frame.queueNote, tone: "mute" }], cols - 4))));
    return parts;
  }

  table(t, c, table, cols) {
    // As the collapsing terminal view: a ticket for a later run is one line under the table, not a row of its own.
    const listed = table.later.ids.length > 0 ? table.rows.filter((r) => r.state !== "later") : table.rows;
    const longest = Math.max(0, ...listed.map((r) => width(r.shown)));
    const cols_ = tableColumns(cols, longest);
    const centred = (name) => name !== "STATE" && name !== "ACTIVITY";
    const cell = (col, i, content) =>
      h_flex().h_full().overflow_hidden().px(CELL)
        .when(col.name === "ACTIVITY", (el) => el.flex_1().min_w(0))
        .when(col.name !== "ACTIVITY", (el) => el.flex_none().w((col.width + 1) * CELL))
        .when(centred(col.name), (el) => el.justify_center())
        .when(i > 0, (el) => el.border_l(1).border_color(t.border))
        .child(content);
    const text = (s, tone, ellipsis) => div().whitespace_nowrap().text_color(c[tone] ?? c.plain).when(ellipsis, (el) => el.min_w(0).text_ellipsis()).child(s);
    const link = (r) => {
      const n = /^\d+/.exec(r.id)?.[0];
      const id = div().font_bold().whitespace_nowrap().text_color(c.wht).child(r.shown);
      // The number opens the ticket in its tracker: a GitHub issue, through `gh` in the project.
      return n
        ? id.id(`link-${r.id}`).cursor_pointer().hover((s) => s.underline()).on_click(() => {
            exec("gh", ["issue", "view", n, "--web"], { cwd: this.root }).catch(() => {});
          })
        : id;
    };
    const content = (col, r) => {
      switch (col.name) {
        case "TICKET":
          return link(r);
        case "STATE":
          return text(`${r.glyph} ${r.state}`, r.tone, true);
        case "TIME":
          return text(r.time, r.timeTone);
        case "DIFF": {
          const m = /^(\+\S+) (−\S+)$/.exec(r.diff);
          return m ? this.segs(c, [{ text: m[1], tone: "grn" }, { text: " ", tone: "plain" }, { text: m[2], tone: "hot" }]) : text(r.diff, "gry");
        }
        case "CPU/MEM":
          return r.cpu ? this.segs(c, [{ text: r.cpu.cpu, tone: r.cpu.hot ? "hot" : "head" }, { text: `/${r.cpu.mem}`, tone: "head" }]) : text("-", "gry");
        case "TOKENS": {
          if (!r.tokens) return text("-", "gry");
          const [input, output] = r.tokens.split("/");
          if (r.cache === undefined || input === undefined || output === undefined) return text(r.tokens, "head");
          const share = `${r.cache}%`;
          for (const gap of [" ", ""]) {
            if (input.length + 1 + share.length + gap.length + output.length > col.width - 2) continue;
            return this.segs(c, [{ text: input, tone: "head" }, { text: " ", tone: "plain" }, { text: share, tone: r.cache < CACHE_AMBER ? "ylw" : "head" }, { text: `${gap}${output}`, tone: "head" }]);
          }
          return text(r.tokens, "head");
        }
        default:
          return text(r.note, r.noteTone, true);
      }
    };
    const line = (key, cells) => h_flex().id(key).h(SIZE * 1.7).items_center().children(cells);

    const out = [line("headings", cols_.map((col, i) => cell(col, i, div().font_bold().text_color(c.head).child(col.name)))).border_t(1).border_b(1).border_color(t.border)];
    const body = [];
    if (listed.length === 0) {
      const runRow = (this.doc.frame.lanes[0]?.rows[0] ?? []).map((s) => s.text).join("");
      const empty = runRow.includes("no run recorded yet") ? "(no runs yet)" : "(nothing to show)";
      body.push(line("empty", cols_.map((col, i) => cell(col, i, col.name === "ACTIVITY" ? text(empty, "mute") : div()))));
    }
    let prio;
    for (const r of listed) {
      // A light rule between groups, as the terminal draws one.
      const apart = prio !== undefined && r.prio !== prio;
      prio = r.prio;
      body.push(line(`row-${r.id}`, cols_.map((col, i) => cell(col, i, content(col, r))))
        .when(apart, (el) => el.border_t(1).border_color(t.border)).hover((s) => s.bg(t.hover)));
    }
    out.push(v_flex().id("rows").flex_1().min_h(SIZE * 4).overflow_y_scrollbar().children(body));
    if (listed !== table.rows) {
      const n = table.later.ids.length;
      const words = `${n} for a later run (${idRange(table.later.ids)})${table.later.blocked > 0 ? `, ${table.later.blocked} blocked` : ""}`;
      out.push(div().px(CELL).py(2).border_t(1).border_color(t.border).child(this.segs(c, cut([{ text: words, tone: "gry" }], cols - 4))));
    }
    return { parts: out, shown: new Set(cols_.map((col) => col.name)) };
  }

  footer(t, c, frame, table, cols, shown) {
    // The counts bar: each group with its count, in its colour, the count bold. A `--no-queue` table merged with the
    // last full read counts what it shows, so the counts are the table's, and `later` is shown once it has any.
    const groups = frame.legend.groups.map((g) => ({ ...g, count: table.counts[g.name] ?? g.count }));
    if (table.counts.later > 0 && !groups.some((g) => g.name === "later")) {
      groups.splice(groups.findIndex((g) => g.name === "left over"), 0, { name: "later", count: 0, segments: [{ text: "… later ", tone: "gry" }, { text: "", tone: "gry", bold: true }] });
    }
    const legend = groups.map((g) => {
      const tone = g.segments[0].tone;
      return [{ text: g.segments[0].text, tone }, { text: String(table.counts[g.name] ?? g.count), tone, bold: true }];
    });
    // Every group on one line from 130 cells where they fit, else rows of four, or of two (as the terminal).
    let per = cols < 130 ? 4 : legend.length;
    for (;;) {
      const need = [];
      for (let col = 0; col < per; col++) {
        let w = 0;
        for (let r = col; r < legend.length; r += per) w = Math.max(w, rowWidth(legend[r]));
        need.push(w + 4);
      }
      if (per <= 2 || need.reduce((a, b) => a + b, 0) + per + 1 <= cols) break;
      per = Math.floor((per + 1) / 2);
    }
    const bars = [];
    for (let r = 0; r < legend.length; r += per) {
      const slice = legend.slice(r, r + per);
      while (slice.length < per) slice.push(null);
      bars.push(h_flex().border_t(1).border_color(t.border).children(slice.map((g, i) =>
        h_flex().flex_1().min_w(0).justify_center().py(2).when(i > 0, (el) => el.border_l(1).border_color(t.border)).child(g ? this.segs(c, g) : div()))));
    }
    // The notes, wrapped and centred; a note whose column the pane does not show goes with it.
    const notes = frame.legend.notes.filter((n) => !n.column || shown.has(n.column)).map((n) => n.segments);
    // A note longer than the pane on a line of its own ends in `…`, as the terminal cuts it.
    const lines = wrapItems(cols - 4, notes, [{ text: " · ", tone: "gry" }]).map((l) => cut(l, cols - 4));
    return [...bars, v_flex().items_center().py(2).border_t(1).border_color(t.border).children(lines.map((l) => this.segs(c, l)))];
  }

  render(_cx) {
    const t = theme();
    const fontSize = Number(settings()?.font_size);
    SIZE = fontSize > 0 ? fontSize : 14;
    CELL = SIZE * 0.6;
    const c = colours(t, settings()?.dark !== false);
    // The root never takes its width from what it holds: the cells are sized from the pane's width, and a pane that
    // grew to fit them would report a wider size, more columns, wider cells, and grow again.
    const root = v_flex().id("root").size_full().min_w(0).overflow_hidden().bg(t.surface).p(PAD).gap(6).font_family(FONT).text_size(SIZE)
      .on_size_change((size, cx) => {
        // The size is in zoomed pixels; the mod's own sizes are at zoom 1.
        const cols = Math.max(Math.floor((size.width / (Number(settings()?.zoom) || 1) - 2 * PAD - 2) / CELL), 40);
        if (cols !== this.cols) {
          this.cols = cols;
          cx.notify();
        }
      });
    if (!this.doc) {
      // Nothing read yet: loading, or the first read failed (unavailable) and says why.
      return root.child(div().text_color(this.error ? c.hot : c.mute).child(this.error ? `○ unavailable - ${this.error}` : "○ loading…"))
        .child(div().text_color(c.gry).child(this.root));
    }
    const { frame, table } = this.doc;
    const cols = this.cols;
    const tbl = this.table(t, c, table, cols);
    // A read that failed keeps the last reading on screen, marked stale with the reason, as the terminal keeps a source's last good value.
    const state = this.error
      ? [{ text: `● stale since ${this.readAt}`, tone: "ylw" }, { text: ` - ${this.error}`, tone: "mute" }]
      : [{ text: `read ${this.readAt} in ${this.cost} ms`, tone: "gry" }];
    return root
      .child(v_flex().flex_1().min_h(0).min_w(0).border(1).border_color(t.border).rounded(4).overflow_hidden()
        .children(this.header(t, c, frame, table, cols))
        .children(tbl.parts)
        .children(this.footer(t, c, frame, table, cols, tbl.shown)))
      .child(this.segs(c, cut(state, cols)));
  }
}
