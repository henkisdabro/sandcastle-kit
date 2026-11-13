// sandcastle: a project's status view as a native pane of the Herdr app (#957).
//
// One model of the view, two renderers: `sandcastle status --json --frame` prints the terminal view's own facts - the
// table (`ticketRows`, src/status-rows.ts) and the frame (`frameFacts`, src/status-frame.ts: the castle, the title,
// the lanes, the legend and the queue note) as segments of text and palette tone names. This mod draws the same
// words, groups, counts and tones, in the app's own type and components rather than the terminal's character grid:
// the castle as an image, gauges as bars, states as badges, the table with its figures aligned, and a layout that
// gives way by the pane's pixels (lanes wrap under the title; CPU/MEM, DIFF and TOKENS give way, in the terminal's
// order, before ACTIVITY gets too narrow). It decides nothing about a ticket itself.
//
// Liveness (#871): `watchFolder` on `.sandcastle/logs` wakes a read when `run.json` or `outcomes.json` changes (the
// agents' logs change constantly, and would read back to back), with `--no-queue` (no tracker call); a 15 s timer
// reads everything, the queue included. One read at a time, at most one every 2 s. A `--no-queue` table keeps, from
// the last full read, every row it lacks (the contract in `Table.queueRead`).
//
// Props: `project` (the project root; default: the focused pane's folder when the pane opens) and `command` (the
// argv that prints the facts; default `sandcastle status --json --frame`; a test points it at a fixture's wrapper).

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, watchFolder, theme, props, focused, settings } from "herdr";

const DEFAULT_COMMAND = ["sandcastle", "status", "--json", "--frame"];
// Git, Docker and the queue change without a write the wake sees: read everything this often regardless.
const FULL_MS = 15_000;
// The least time between two reads' starts: a read is a Node process (and a `gh` call on a full read).
const GAP_MS = 2_000;
// The records that change a row's state; the agents' logs beside them are written all the time.
const WAKES = new Set(["run.json", "outcomes.json"]);

// Figures (ticket numbers, times, diffs, tokens) line up in the terminals' monospace font; everything else is the
// app's UI font.
const MONO = "JetBrains Mono";
// The table's columns at zoom 1: each its least width, then a share of the pane's spare width by its weight, up to
// its most; ACTIVITY takes the most and the rest. Below ACTIVITY's least the others give way in the terminal view's
// order (src/status-render.ts GIVE_WAY), and STATE narrows to its least.
const COLUMNS = [
  { name: "TICKET", min: 64, weight: 0.6, max: 110, align: "end", mono: true },
  { name: "STATE", min: 112, weight: 1.2, max: 200, align: "start" },
  { name: "TIME", min: 68, weight: 0.7, max: 130, align: "end", mono: true },
  { name: "DIFF", min: 96, weight: 0.9, max: 170, align: "end", mono: true },
  { name: "CPU/MEM", min: 96, weight: 0.9, max: 170, align: "end", mono: true },
  { name: "TOKENS", min: 124, weight: 1, max: 200, align: "end", mono: true },
];
const ACTIVITY_WEIGHT = 4;
const ACTIVITY_MIN = 220;
const GIVE_WAY = ["CPU/MEM", "DIFF", "TOKENS"];
// A cache share under this is amber (CACHE_AMBER in src/status-frame.ts; the TOKENS note says the figure).
const CACHE_AMBER = 70;
// The lanes whose rows are key and value: the key (the row's first, muted segment) gets a column of its own.
const KEYED = new Set(["MACHINE", "MODELS", "PLAN"]);
const PAD = 14;
const BAR = /^[█░▓]+$/;

const two = (n) => String(n).padStart(2, "0");
const clockNow = () => {
  const d = new Date();
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/** The palette's tone names (src/status-render.ts `palette`) as theme colours. */
const colours = (t) => ({
  plain: t.foreground, head: t.foreground, wht: t.foreground, accent: t.accent, mute: t.muted, gry: t.dim, rule: t.dim,
  grn: t.ansi2, ylw: t.ansi3, cyn: t.ansi6, blu: t.ansi4, hot: t.ansi1,
  moon: t.foreground, dusk: t.muted, night: t.muted, deep: t.dim, star: t.dim,
});

/** A theme colour at `alpha` (0-255) for a badge's fill; a colour that is not `#rrggbb` falls back to `fallback`. */
const tint = (colour, alpha, fallback) => (/^#[0-9a-f]{6}$/i.test(colour ?? "") ? `${colour}${alpha.toString(16).padStart(2, "0")}` : fallback);

/** A row's text with runs of spaces as one, none leading or trailing: the terminal's padding means nothing here. */
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

/** The table's columns and their widths for a table `width` px wide; ACTIVITY's is what the others leave. */
const tableColumns = (width) => {
  const fixed = COLUMNS.map((c) => ({ ...c, width: c.min }));
  const used = () => fixed.reduce((a, c) => a + c.width, 0);
  for (const name of GIVE_WAY) {
    if (width - used() >= ACTIVITY_MIN) break;
    fixed.splice(fixed.findIndex((c) => c.name === name), 1);
  }
  // Spread the spare width by weight, ACTIVITY's weight included, each column up to its most.
  const spare = Math.max(width - used() - ACTIVITY_MIN, 0);
  const weights = fixed.reduce((a, c) => a + c.weight, ACTIVITY_WEIGHT);
  for (const c of fixed) c.width = Math.min(c.min + (spare * c.weight) / weights, c.max);
  // Too narrow even for the least widths: STATE gives up what it can.
  const state = fixed.find((c) => c.name === "STATE");
  state.width = Math.max(state.width - Math.max(ACTIVITY_MIN - (width - used()), 0), 96);
  return [...fixed.map((c) => ({ ...c, width: Math.floor(c.width) })), { name: "ACTIVITY", align: "start" }];
};

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
    this.width = 900; // the pane's width in px at zoom 1, from on_size_change
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

  /** A run of segments as text, each in its tone; a run of bar characters (a gauge, a usage window) as a bar. */
  segs(t, c, row, size) {
    const parts = [];
    for (let i = 0; i < row.length; i++) {
      const s = row[i];
      if (BAR.test(s.text)) {
        // The bar's cells: filled ones in this tone, then the empty rest (`░`) in the next segment.
        let filled = 0;
        let total = 0;
        let tone = "head";
        for (; i < row.length && BAR.test(row[i].text); i++) {
          const n = [...row[i].text].length;
          total += n;
          if (!/^░+$/.test(row[i].text)) {
            filled += n;
            tone = row[i].tone;
          }
        }
        i--;
        parts.push(div().flex_none().w(Math.max(total * 9, 36)).h(6).mx(4).rounded_full().bg(t.hover)
          .child(div().h_full().rounded_full().w(Math.max(total * 9, 36) * (filled / (total || 1))).bg(c[tone] ?? c.head)));
        continue;
      }
      parts.push(div().flex_none().whitespace_nowrap().text_color(c[s.tone] ?? c.plain).when(Boolean(s.bold), (el) => el.font_semibold()).child(s.text));
    }
    // A row longer than its card wraps between its pieces rather than losing words off its end.
    return h_flex().flex_wrap().items_center().min_w(0).when(size !== undefined, (el) => el.text_size(size)).children(parts);
  }

  /** The clock segment shows this machine's time now, as the terminal's view redraws it each second. */
  ticking(row, clock) {
    return row.map((s) => (s.text === clock && s.tone === "accent" ? { ...s, text: clockNow() } : s));
  }

  title(t, c, frame) {
    const ti = frame.title;
    const dot = () => div().text_color(t.dim).child("·");
    const meta = [
      h_flex().gap(4).child(div().text_color(t.muted).child("base")).child(div().text_color(t.foreground).font_medium().child(ti.base)),
      ...(ti.unpushed > 0 ? [div().px(6).rounded_full().bg(tint(c.hot, 0x2e, t.raised)).text_color(c.hot).child(`↑${ti.unpushed} unpushed`)] : []),
      div().font_family(MONO).text_color(t.accent).child(clockNow()),
      ...(ti.version ? [div().text_color(t.muted).child(`v${ti.version}`)] : []),
    ].flatMap((el, i) => (i === 0 ? [el] : [dot(), el]));
    return h_flex().flex_none().gap(12).items_center().min_w(260).py(4)
      .child(image(`mods/sandcastle/${settings()?.dark === false ? "castle-light" : "castle"}.svg`).flex_none().w(48).h(45))
      .child(v_flex().gap(2).min_w(0)
        .child(h_flex().gap(4).text_size(11).font_semibold().text_color(t.muted).child(ti.wordmark))
        .child(div().text_size(18).font_semibold().text_color(t.foreground).text_ellipsis().child(ti.name))
        .child(h_flex().gap(6).items_center().flex_wrap().text_size(12).children(meta)));
  }

  lane(t, c, lane) {
    const keyed = KEYED.has(lane.name);
    const rows = lane.rows.map((r) => {
      if (!keyed) return this.segs(t, c, squeeze(r));
      // A key column: the row's first muted segment, or none when the row continues the one above (PLAN's windows).
      const lead = r[0] && r[0].tone === "mute" ? r[0].text.trim() : "";
      const rest = squeeze(lead ? r.slice(1) : r);
      return h_flex().gap(8).min_w(0)
        .child(div().flex_none().w(64).text_color(t.muted).child(lead))
        .child(this.segs(t, c, rest));
    });
    return v_flex().flex_1().min_w(200).gap(3).p(10).rounded(6).bg(t.raised)
      .child(div().text_size(10.5).font_semibold().text_color(t.muted).child(lane.title.text))
      .children(rows.map((r, i) => (lane.rows[i]?.length ? r : div().h(4))));
  }

  header(t, c, frame) {
    // The title and the lanes in one wrapping row: in a wide pane the lanes sit beside the title, in a narrow one
    // they wrap under it, each still whole.
    const out = [h_flex().flex_wrap().gap(10).items_start().child(this.title(t, c, frame)).children(frame.lanes.map((l) => this.lane(t, c, l)))];
    if (frame.queueNote) out.push(h_flex().gap(6).text_size(12).text_color(c.ylw).child("⚠").child(div().text_color(t.muted).text_ellipsis().child(frame.queueNote)));
    return out;
  }

  table(t, c, table) {
    // As the collapsing terminal view: a ticket for a later run is one line under the table, not a row of its own.
    const listed = table.later.ids.length > 0 ? table.rows.filter((r) => r.state !== "later") : table.rows;
    const cols = tableColumns(this.width - 2 * PAD);
    const cell = (col, content) =>
      h_flex().items_center().min_w(0).overflow_hidden().px(6)
        .when(col.name === "ACTIVITY", (el) => el.flex_1())
        .when(col.name !== "ACTIVITY", (el) => el.flex_none().w(col.width))
        .when(col.align === "end", (el) => el.justify_end())
        .when(Boolean(col.mono), (el) => el.font_family(MONO).text_size(11.5))
        .child(content);
    const text = (s, tone) => div().whitespace_nowrap().min_w(0).text_ellipsis().text_color(c[tone] ?? c.plain).child(s);
    const link = (r) => {
      const n = /^\d+/.exec(r.id)?.[0];
      const id = div().font_semibold().whitespace_nowrap().text_color(t.foreground).child(r.shown);
      // The number opens the ticket in its tracker: a GitHub issue, through `gh` in the project.
      return n
        ? id.id(`link-${r.id}`).cursor_pointer().hover((s) => s.underline().text_color(t.accent)).on_click(() => {
            exec("gh", ["issue", "view", n, "--web"], { cwd: this.root }).catch(() => {});
          })
        : id;
    };
    // The state as a badge in its tone: the glyph and the word, as the terminal shows them.
    const badge = (r) =>
      h_flex().gap(4).px(7).py(1).rounded_full().min_w(0).overflow_hidden().bg(tint(c[r.tone], 0x26, t.hover)).text_color(c[r.tone] ?? c.plain).text_size(11.5).font_medium()
        .child(div().flex_none().child(r.glyph)).child(div().whitespace_nowrap().text_ellipsis().min_w(0).child(r.state));
    const content = (col, r) => {
      switch (col.name) {
        case "TICKET":
          return link(r);
        case "STATE":
          return badge(r);
        case "TIME":
          return text(r.time, r.timeTone);
        case "DIFF": {
          const m = /^(\+\S+) (−\S+)$/.exec(r.diff);
          return m ? h_flex().gap(6).child(div().text_color(c.grn).child(m[1])).child(div().text_color(c.hot).child(m[2])) : text(r.diff, "gry");
        }
        case "CPU/MEM":
          return r.cpu ? h_flex().child(div().text_color(r.cpu.hot ? c.hot : t.foreground).child(r.cpu.cpu)).child(div().text_color(t.muted).child(`/${r.cpu.mem}`)) : text("-", "gry");
        case "TOKENS": {
          if (!r.tokens) return text("-", "gry");
          const [input, output] = r.tokens.split("/");
          if (r.cache === undefined || input === undefined || output === undefined) return text(r.tokens, "head");
          return h_flex().gap(6)
            .child(div().text_color(t.foreground).child(input))
            .child(div().text_color(r.cache < CACHE_AMBER ? c.ylw : t.muted).child(`${r.cache}%`))
            .child(div().text_color(t.foreground).child(output));
        }
        default:
          return text(r.note, r.noteTone);
      }
    };
    const out = [
      h_flex().h(26).items_center().border_b(1).border_color(t.border).text_size(10.5).font_semibold().text_color(t.muted)
        .children(cols.map((col) => cell({ ...col, mono: false }, div().child(col.name)))),
    ];
    const body = [];
    if (listed.length === 0) {
      const runRow = (this.doc.frame.lanes[0]?.rows[0] ?? []).map((s) => s.text).join("");
      body.push(div().p(12).text_color(t.muted).child(runRow.includes("no run recorded yet") ? "No runs yet" : "Nothing to show"));
    }
    let prio;
    for (const r of listed) {
      // The groups apart, as the terminal draws a rule between them.
      const apart = prio !== undefined && r.prio !== prio;
      prio = r.prio;
      body.push(h_flex().id(`row-${r.id}`).h(28).items_center().rounded(4).hover((s) => s.bg(t.hover))
        .when(apart, (el) => el.mt(5).border_t(1).border_color(t.border))
        .children(cols.map((col) => cell(col, content(col, r)))));
    }
    out.push(v_flex().id("rows").flex_1().min_h(80).overflow_y_scrollbar().text_size(12.5).children(body));
    if (listed !== table.rows) {
      const n = table.later.ids.length;
      out.push(div().px(6).py(4).border_t(1).border_color(t.border).text_size(12).text_color(t.dim)
        .child(`${n} for a later run (${idRange(table.later.ids)})${table.later.blocked > 0 ? `, ${table.later.blocked} blocked` : ""}`));
    }
    return { parts: out, shown: new Set(cols.map((col) => col.name)) };
  }

  footer(t, c, frame, table, shown) {
    // The counts: each group with its count, in its colour. A `--no-queue` table merged with the last full read
    // counts what it shows, so the counts are the table's, and `later` is shown once it has any.
    const groups = [...frame.legend.groups];
    if (table.counts.later > 0 && !groups.some((g) => g.name === "later")) {
      groups.splice(groups.findIndex((g) => g.name === "left over"), 0, { name: "later", segments: [{ text: "… later ", tone: "gry" }] });
    }
    const pills = groups.map((g) => {
      const tone = g.segments[0].tone;
      const count = table.counts[g.name] ?? g.count;
      return h_flex().gap(6).px(9).py(3).rounded_full().items_center().bg(count > 0 ? tint(c[tone], 0x22, t.raised) : t.raised)
        .text_color(count > 0 ? c[tone] : t.dim)
        .child(div().child(g.segments[0].text.trim())).child(div().font_semibold().child(String(count)));
    });
    // The notes; one whose column the pane does not show goes with it.
    const notes = frame.legend.notes.filter((n) => !n.column || shown.has(n.column)).map((n) => n.segments.map((s) => s.text).join(""));
    return [
      h_flex().flex_wrap().gap(6).pt(8).border_t(1).border_color(t.border).text_size(12).children(pills),
      h_flex().flex_wrap().gap_x(14).text_size(11.5).text_color(t.dim).children(notes.map((n) => div().child(n))),
    ];
  }

  render(_cx) {
    const t = theme();
    const c = colours(t);
    // The root never takes its width from what it holds: the columns are sized from the pane's width, and a pane
    // that grew to fit them would report a wider size and grow again.
    const root = v_flex().id("root").size_full().min_w(0).overflow_hidden().bg(t.surface).p(PAD).gap(10).text_size(12.5).text_color(t.foreground)
      .on_size_change((size, cx) => {
        // The size is in zoomed pixels; the mod's own sizes are at zoom 1.
        const width = Math.floor(size.width / (Number(settings()?.zoom) || 1));
        if (width !== this.width) {
          this.width = width;
          cx.notify();
        }
      });
    if (!this.doc) {
      // Nothing read yet: loading, or the first read failed (unavailable) and says why.
      return root.child(div().text_color(this.error ? c.hot : t.muted).child(this.error ? `Unavailable - ${this.error}` : "Loading…"))
        .child(div().text_size(11.5).text_color(t.dim).child(this.root));
    }
    const { frame, table } = this.doc;
    const tbl = this.table(t, c, table);
    // A read that failed keeps the last reading on screen, marked stale with the reason, as the terminal keeps a
    // source's last good value.
    const state = this.error
      ? h_flex().gap(6).min_w(0).child(div().flex_none().px(6).rounded_full().bg(tint(c.ylw, 0x2e, t.raised)).text_color(c.ylw).child(`stale since ${this.readAt}`)).child(div().text_ellipsis().text_color(t.muted).child(this.error))
      : div().text_color(t.dim).child(`read ${this.readAt} in ${this.cost} ms`);
    return root
      .children(this.header(t, c, frame))
      .child(v_flex().flex_1().min_h(0).children(tbl.parts))
      .children(this.footer(t, c, frame, table, tbl.shown))
      .child(h_flex().text_size(11).child(state));
  }
}
