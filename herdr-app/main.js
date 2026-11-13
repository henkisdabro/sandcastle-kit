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
//
// The rows act (#960). A click on a row whose ticket has a sandbox terminal (herdr-core's slot, `row.terminal`)
// peeks at it (`terminal.peek`); a click on any other row opens the ticket's card, the Herdr TUI plugin's card as
// data (`sandcastle herdr card --json`), where each pass opens its log in a read-only Editor pane. A right-click
// opens a menu: the card, the newest log, the tracker link, the log folder, and the sandbox peeked at or in a
// floating window. The same mod draws each of those, by its props: `card`, `menu` and `bar` (the window's title
// and close) in overlays, `log` as a pane. The `sandcastle` they run is the status command's, so a run from a clone
// of the kit asks that clone.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { exec, watchFolder, theme, props, focused, settings, run, openOverlay, closeOverlay, notify } from "herdr";

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
// The header's cards: one gap between them (and the title), one inner padding, one row gap, one key column.
const CARD_GAP = 10;
const CARD_PAD = 10;
const LANE_ROW_GAP = 3;
const KEY_WIDTH = 72;
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

// ---- the row actions (#960) ----

// A log pane shows at most this much of the file's end: a long agent log stays quick to draw.
const LOG_TAIL = 400_000;
// Every control character but newline and tab goes: an agent's log is its own text, and an escape in it is noise here.
// oxlint-disable-next-line no-control-regex -- matching escape sequences and control characters is the point: it strips them
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** The `sandcastle` the status command runs (its first word when it is `... status`), else the one on PATH. */
const binOf = (command) => (Array.isArray(command) && command[1] === "status" ? command[0] : "sandcastle");
const logsOf = (root) => `${root}/.sandcastle/logs`;

/** Opens a URL or folder with the system's opener: `open` on macOS, `xdg-open` elsewhere. */
const openExternal = async (target) => {
  for (const opener of ["open", "xdg-open"]) {
    try {
      if ((await exec(opener, [target])).code === 0) return true;
    } catch {
      // not this system's opener
    }
  }
  notify({ title: "sandcastle", body: `Could not open ${target}`, level: "warning" });
  return false;
};

/** A file in a read-only Editor pane under the focused pane (the status pane a row was clicked in). */
const openFile = (path, root) => run("pane.split", { direction: "down", mod: "sandcastle", props: { log: path, project: root } });

/** The ticket's card as `sandcastle herdr card --json` prints it, or a reason it could not be read. */
const readCard = async (bin, root, id) => {
  try {
    const r = await exec(bin, ["herdr", "card", "--json", root, id], { cwd: root, timeout: 30_000 });
    if (r.code !== 0) return { error: r.stderr.trim().split("\n").pop() || r.stdout.trim().split("\n").pop() || `exit ${r.code}` };
    return { card: JSON.parse(r.stdout) };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
};

/** A pass's log, else the newest log of any kind: what "Newest log" opens. */
const newestLog = (card) => [...card.passes].reverse().find((p) => p.log)?.log ?? card.logs[card.logs.length - 1];

/** The tracker link the card found: a page opens in the browser, a ticket file in a read-only pane. */
const openTracker = (tracker, root) => {
  if (/^https?:\/\//.test(tracker)) return void openExternal(tracker);
  if (tracker.startsWith("/")) return void openFile(tracker, root);
  notify({ title: "sandcastle", body: tracker, level: "info" });
};

const peek = (terminal) => run("terminal.peek", { terminal });
/** The sandbox terminal in a floating window: the window's bar (this mod) names it and closes it. */
const sandboxWindow = (terminal, title) =>
  openOverlay({
    kind: "window",
    key: `sandcastle-sandbox-${terminal}`,
    width: 0.6,
    height: 0.6,
    layout: {
      id: "sandbox",
      type: "column",
      children: [
        { id: "sandbox-bar", type: "block", size: { px: 30 }, content: { mod: "sandcastle", props: { bar: { title } } } },
        { id: "sandbox-terminal", type: "block", content: { terminal } },
      ],
    },
  });

// ---- the run's controls (#961) ----

/**
 * The closing report (`sandcastle report`, markdown) in a floating window of its own: it never takes the keyboard.
 * The run's start is in the key: a window left open from an earlier run keeps that run's report, and the app would
 * show it again, unread, for the next run's under the same key.
 */
const openReport = (project, bin, run) =>
  openOverlay({ kind: "window", key: `sandcastle-report-${project}-${run?.startedAt ?? ""}`, width: 0.55, height: 0.7, mod: "sandcastle", props: { report: { project, bin, started: startedClock(run?.startedAt) } } });

// The run's start as the report window's title shows it: windows left open from earlier runs look alike otherwise.
const startedClock = (startedAt) => {
  const d = new Date(startedAt ?? "");
  return Number.isNaN(d.getTime()) ? "" : `${two(d.getHours())}:${two(d.getMinutes())}`;
};

// A heading's, a list item's or a numbered step's mark at a line's start: the report's own markdown, kept.
// `[^]*`, not `.*`: `.` stops at U+2028 and U+2029, which a ticket title may hold, and the match would fail.
const MARK = /^(\s*(?:#{1,6} |[-*+] |\d+\. )?)([^]*)$/;
/**
 * The report's text as markdown that shows each line as written. Ticket titles (anyone can file one on a public repo)
 * and agents' notes are in it: a link or an image in them would be live (an image loads from its host), and `_` or
 * `*` in a path would turn to emphasis. Every ASCII punctuation mark after a line's own mark is escaped, outside a
 * code span (where markdown is literal already, and a backslash would show). A hard break at each line's end keeps
 * the terminal's lines, which markdown would fold into a paragraph; fenced code is left as it is.
 */
const reportMarkdown = (text) => {
  let fenced = false;
  return text.split("\n").map((l) => {
    if (l.startsWith("```")) fenced = !fenced;
    if (fenced || l.startsWith("```") || !l.trim()) return l;
    const [, mark, rest] = MARK.exec(l);
    const body = rest.split(/(`[^`]+`)/).map((part, i) => (i % 2 ? part : part.replace(/[!-/:-@[-`{-~]/g, "\\$&"))).join("");
    return `${mark}${body}  `;
  }).join("\n");
};

/** The status line in a small floating window of its own, with the run's buttons: opened only by its button. */
const openLine = (project, command) =>
  openOverlay({ kind: "window", key: `sandcastle-line-${project}`, width: 520, height: 46, frame: "none", mod: "sandcastle", props: { project, command, line: true } });

const openCard = (ticket) => openOverlay({ mod: "sandcastle", kind: "dialog", width: 620, height: 460, props: { card: ticket } });

/** The right-click menu's items for a row: `[label, action]`. */
const menuItems = (m) => [
  ["Ticket card", () => openCard(m)],
  ["Newest log", async () => {
    const { card, error } = await readCard(m.bin, m.project, m.id);
    const log = card && newestLog(card);
    if (log) openFile(`${logsOf(m.project)}/${log}`, m.project);
    else notify({ title: "sandcastle", body: error ?? `${m.shown} has no logs here`, level: "info" });
  }],
  ...(m.terminal ? [["Peek at the sandbox", () => peek(m.terminal)], ["Sandbox in a window", () => sandboxWindow(m.terminal, `${m.shown} sandbox`)]] : []),
  ["Open in the tracker", async () => {
    const { card, error } = await readCard(m.bin, m.project, m.id);
    if (card?.tracker) openTracker(card.tracker, m.project);
    else notify({ title: "sandcastle", body: error ?? "No tracker link", level: "warning" });
  }],
  ["Open the log folder", () => void openExternal(logsOf(m.project))],
];

export default class SandcastleStatus extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.card ? "card" : p.menu ? "menu" : p.log ? "log" : p.bar ? "bar" : p.report ? "report" : p.line ? "line" : "status";
    if (this.role === "report") return this.initReport(cx);
    if (this.role === "card") return this.initCard(cx);
    if (this.role === "menu") return this.initMenu(cx);
    if (this.role === "log") return this.initLog(cx);
    if (this.role === "bar") return;
    this.initStatus(cx);
  }

  // ---- the card (a dialog) ----

  initCard(cx) {
    this.ticket = props().card;
    this.card = null;
    this.error = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      const { card, error } = await readCard(this.ticket.bin, this.ticket.project, this.ticket.id);
      this.card = card ?? null;
      this.error = error ?? "";
      cx.notify();
    });
  }

  renderCard() {
    const t = theme();
    const c = colours(t);
    const close = () => closeOverlay(props().overlay);
    const action = (id, label, fn) =>
      div().id(id).px(8).py(2).rounded(5).cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover)).on_click(() => fn()).child(label);
    const root = v_flex().id("card").track_focus(this.handle).size_full().min_h(0).p(16).gap(10).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .on_key_down((e) => {
        if (e.key === "escape") close();
      });
    const card = this.card;
    const head = h_flex().gap(8).items_center()
      .child(div().text_size(16).font_semibold().child(card?.ref ?? this.ticket.shown))
      .child(div().flex_1().min_w(0).text_ellipsis().text_color(t.muted).child(card?.title ?? ""))
      .child(action("card-close", "Close", close));
    if (!card) return root.child(head).child(div().text_color(this.error ? c.hot : t.muted).child(this.error || "Loading…"));
    const logs = logsOf(this.ticket.project);
    const rows = card.passes.map((p, i) =>
      h_flex().id(`pass-${i}`).h(26).gap(10).px(6).items_center().rounded(4)
        .when(Boolean(p.log), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => {
          openFile(`${logs}/${p.log}`, this.ticket.project);
          close();
        }))
        .child(div().w(110).flex_none().child(p.pass))
        .child(div().flex_1().min_w(0).text_ellipsis().text_color(/^(red|failed)/.test(p.outcome) ? c.hot : p.outcome === "running" ? c.ylw : c.grn).child(p.outcome))
        .child(div().w(70).flex_none().font_family(MONO).text_size(11.5).text_color(t.muted).child(p.time))
        .child(div().w(36).flex_none().text_color(p.log ? t.accent : t.dim).child(p.log ? "log" : "")));
    const others = card.inRun ? [] : card.logs.map((f, i) =>
      h_flex().id(`log-${i}`).h(24).px(6).items_center().rounded(4).cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover))
        .on_click(() => {
          openFile(`${logs}/${f}`, this.ticket.project);
          close();
        }).child(f));
    return root
      .child(head)
      .child(div().text_color(t.muted).child(card.inRun ? card.status : "Not in the last run: run.json has no entry for this ticket."))
      .child(v_flex().id("passes").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .children(card.inRun && !rows.length ? [div().text_color(t.dim).child("No pass of it is timed in this run yet.")] : rows)
        .children(others)
        .children(card.why.map((w) => div().pt(4).text_color(c.ylw).child(w)))
        .when(Boolean(card.gateTail?.length), (el) => el.child(div().pt(6).text_color(t.muted).child("The gates log ends:"))
          .children(card.gateTail.map((l) => div().font_family(MONO).text_size(11.5).text_color(t.dim).child(l)))))
      .child(h_flex().gap(6).pt(6).border_t(1).border_color(t.border).flex_wrap()
        .when(Boolean(this.ticket.terminal), (el) => el.child(action("card-peek", "Peek at the sandbox", () => {
          close();
          peek(this.ticket.terminal);
        })))
        // A link or a ticket file opens; anything else is the reason there is none, said as text.
        .when(Boolean(card.tracker), (el) => el.child(/^https?:|^\//.test(card.tracker)
          ? action("card-tracker", card.tracker.startsWith("/") ? "Open the ticket file" : "Open in the tracker", () => {
              close();
              openTracker(card.tracker, this.ticket.project);
            })
          : div().px(8).py(2).text_color(t.dim).child(card.tracker)))
        .child(action("card-folder", "Open the log folder", () => void openExternal(logs))));
  }

  // ---- the right-click menu (a popup) ----

  initMenu(cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  renderMenu() {
    const t = theme();
    const m = props().menu;
    const list = menuItems(m);
    const choose = (i) => {
      closeOverlay(props().overlay);
      list[i]?.[1]();
    };
    return v_flex().id("menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") choose(this.at);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .child(div().px(8).py(3).text_size(11).text_color(t.muted).child(m.shown))
      .children(list.map((it, i) =>
        div().id(`item-${i}`).px(8).py(5).rounded(5).cursor_pointer().when(i === this.at, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
          .on_click(() => choose(i)).child(it[0])));
  }

  // ---- a log, read-only (a pane) ----

  initLog(cx) {
    this.path = props().log;
    this.code = null;
    this.error = "";
    this.cut = false;
    this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("tail", ["-c", String(LOG_TAIL), this.path], { timeout: 10_000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
        const size = await exec("wc", ["-c", this.path]).then((w) => Number(w.stdout.trim().split(/\s+/)[0]) || 0).catch(() => 0);
        this.cut = size > LOG_TAIL;
        const text = plain(r.stdout);
        if (this.code) this.code.set_value(text);
        else this.code = EditorState.new({ language: "txt", readonly: true, soft_wrap: true, value: text, font_family: settings().font_family, font_size: 12 });
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  renderLog() {
    const t = theme();
    const name = this.path.split("/").pop();
    return v_flex().id("log").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_ellipsis().font_semibold().child(name))
        .when(this.cut, (el) => el.child(div().text_size(11).text_color(t.dim).child("its end only")))
        .child(div().id("log-reload").px(8).py(2).rounded(5).cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.load(cx)).child("Reload")))
      .child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(this.error ? t.ansi1 : t.dim).child(this.error || "Loading…"));
  }

  // ---- a sandbox window's bar ----

  renderBar() {
    const t = theme();
    return h_flex().id("bar").size_full().px(10).gap(8).items_center().bg(t.raised).text_size(12).text_color(t.foreground)
      .child(div().flex_1().min_w(0).text_ellipsis().font_semibold().child(props().bar?.title ?? "sandbox"))
      .child(div().id("bar-close").px(8).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => closeOverlay(props().overlay)).child("Close"));
  }

  // ---- the closing report (a window) ----

  initReport(cx) {
    this.text = "";
    this.error = "";
    this.loadReport(cx);
  }

  loadReport(cx) {
    const { project, bin } = props().report;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(bin, ["report"], { cwd: project, timeout: 120_000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
        this.text = reportMarkdown(plain(r.stdout));
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  renderReport() {
    const t = theme();
    // A window is dragged by any press its controls do not stop.
    const button = (id, label, fn) =>
      div().id(id).px(8).py(2).rounded(5).cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => fn(cx)).child(label);
    return v_flex().id("report").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_ellipsis().font_semibold().child(`sandcastle report · ${props().report.project.split("/").pop()}${props().report.started ? ` · run of ${props().report.started}` : ""}`))
        .child(button("report-reload", "Reload", (cx) => this.loadReport(cx)))
        .child(button("report-close", "Close", () => closeOverlay(props().overlay))))
      .child(v_flex().id("report-body").flex_1().min_h(0).overflow_y_scrollbar().p(16)
        .child(this.text ? TextView.markdown("report-text", this.text) : div().text_color(this.error ? t.ansi1 : t.dim).child(this.error || "Loading…")));
  }

  // ---- the status view ----

  initStatus(cx) {
    // The project is fixed when the pane opens: a later focus elsewhere must not turn it into another project's view.
    this.root = props()?.project || focused()?.cwd || "";
    this.doc = null; // the last good reading, `{ table, frame, run }`
    this.full = null; // the last full read (the queue included)
    this.error = "";
    this.readAt = "";
    this.cost = null;
    this.run = null; // the last reading's `run` (src/view-facts.ts runFacts)
    this.busy = ""; // a pause or resume on its way
    this.reportedRun = null; // the `startedAt` of the run whose end this pane opened the report for
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

  /**
   * What changed between two readings of the run. A run this pane saw live that has now ended opens its closing
   * report, once per run (the next run in the same pane opens its own); a pane opened on an ended run opens nothing by
   * itself.
   */
  seen(before, now) {
    // The pane opens the report; a popped-out line reads the same run and must not open it a second time.
    if (this.role !== "status" || !before || !now) return;
    const live = (r) => r.state === "running" || r.state === "paused";
    const started = now.startedAt ?? "";
    if (live(before) && !live(now) && this.reportedRun !== started) {
      this.reportedRun = started;
      openReport(this.root, binOf(props()?.command), now);
    }
  }

  /** Pause or resume the run through the kit's own command, then read again at once. */
  control(verb, cx) {
    if (this.busy) return;
    this.busy = verb;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(binOf(props()?.command), [verb], { cwd: this.root, timeout: 30_000 });
        const said = (r.stdout.trim() || r.stderr.trim()).split("\n").pop() ?? "";
        notify({ title: `sandcastle ${verb}`, body: said || (r.code === 0 ? "done" : `exit ${r.code}`), level: r.code === 0 ? "info" : "warning" });
      } catch (e) {
        notify({ title: `sandcastle ${verb}`, body: String(e?.message ?? e), level: "warning" });
      }
      this.busy = "";
      this.request("logs");
      cx.notify();
    });
  }

  /** The run's buttons: Pause while it runs, Resume while paused, the closing report once it ended. */
  controls(t) {
    const state = this.run?.state;
    const button = (id, label, fn, tone) =>
      div().id(id).flex_none().px(10).py(2).rounded(6).cursor_pointer().border_1().border_color(t.border).text_color(tone ?? t.foreground)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => fn(cx)).child(label);
    const out = [];
    if (state === "running") out.push(button("run-pause", this.busy === "pause" ? "Pausing…" : "Pause", (cx) => this.control("pause", cx)));
    if (state === "paused") out.push(button("run-resume", this.busy === "resume" ? "Resuming…" : "Resume", (cx) => this.control("resume", cx), t.accent));
    if (state === "finished" || state === "ended") out.push(button("run-report", "Report", () => openReport(this.root, binOf(props()?.command), this.run)));
    return out;
  }

  /**
   * The status line: the run's state as a dot, the Herdr TUI tab bar's line for it (`runFacts.line`), and the run's
   * buttons. Pinned across the top of the pane (with a button that pops it out), and the whole of the floating
   * window `openLine` opens (with its Close). The line is one row and cut with an ellipsis: the buttons stay whole.
   */
  statusLine(t, c, inWindow) {
    const run = this.run;
    const tone = !run || run.state === "none" ? t.dim
      : run.counts?.needsYou ? c.hot
      : run.state === "paused" ? c.blu
      : run.state === "running" ? c.ylw
      : run.state === "finished" ? c.grn
      : c.hot;
    const words = !run || run.state === "none" ? "no run yet"
      : `${run.line}${run.state === "finished" ? " · finished" : run.state === "ended" ? " · ended early" : ""}`;
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const small = (id, label, fn) =>
      stop(div().id(id).flex_none().px(8).py(2).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).on_click((_e, cx) => fn(cx)).child(label));
    return h_flex().id(inWindow ? "line-window" : "line").flex_none().h(inWindow ? 46 : 34).px(inWindow ? 12 : 4).gap(8).items_center().min_w(0)
      .when(inWindow, (el) => el.size_full().rounded(10).bg(t.popover).border_1().border_color(t.border))
      .when(!inWindow, (el) => el.border_b(1).border_color(t.border))
      .text_size(12.5).text_color(t.foreground)
      .child(div().flex_none().size(8).rounded_full().bg(tone))
      .child(div().flex_none().text_color(t.muted).child("♜"))
      .child(div().flex_1().min_w(0).whitespace_nowrap().text_ellipsis().font_medium().child(words))
      .children(this.controls(t).map(stop))
      .child(inWindow ? small("line-close", "Close", () => closeOverlay(props().overlay)) : small("line-pop", "Pop out", () => openLine(this.root, props()?.command)));
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
      this.seen(this.run, doc.run);
      this.run = doc.run ?? null;
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
        // No left margin: a gauge starts at the value column's edge, as a text value in the same card does.
        parts.push(div().flex_none().w(Math.max(total * 9, 36)).h(6).mr(6).rounded_full().bg(t.hover)
          .child(div().h_full().rounded_full().w(Math.max(total * 9, 36) * (filled / (total || 1))).bg(c[tone] ?? c.head)));
        continue;
      }
      // A segment breaks after each `, ` so a list (MODELS' `sonnet/high, review opus/high`) wraps between its items;
      // a piece still wider than its card is cut with an ellipsis inside it rather than running past its edge.
      for (const piece of s.text.split(/(?<=, )/)) {
        parts.push(div().min_w(0).overflow_hidden().whitespace_nowrap().text_ellipsis().text_color(c[s.tone] ?? c.plain).when(Boolean(s.bold), (el) => el.font_semibold()).child(piece));
      }
    }
    // A row longer than its card wraps between its pieces rather than losing words off its end.
    // Never `flex_1` or `overflow_hidden` here: in a lane's column the first makes the row's height basis 0 and the
    // second drops its content minimum, so a row that wraps kept one line's height and the next row painted over its
    // second (test/herdr-app-layout.test.ts holds it).
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
    return h_flex().flex_none().gap(12).items_center().min_w(260)
      .child(image(`mods/sandcastle/${settings()?.dark === false ? "castle-light" : "castle"}.svg`).flex_none().w(48).h(45))
      .child(v_flex().gap(2).min_w(0)
        .child(h_flex().gap(4).text_size(11).font_semibold().text_color(t.muted).child(ti.wordmark))
        .child(div().text_size(18).font_semibold().text_color(t.foreground).text_ellipsis().child(ti.name))
        .child(h_flex().gap(6).items_center().flex_wrap().text_size(12).children(meta)));
  }

  lane(t, c, lane) {
    const keyed = KEYED.has(lane.name);
    // The terminal's blank rows only fill its character grid: here every row sits LANE_ROW_GAP apart, and a value
    // that wraps adds only its own extra line.
    const rows = lane.rows.filter((r) => r.length).map((r, i) => {
      if (!keyed) return this.segs(t, c, squeeze(r)).id(`lane-${lane.name}-${i}`);
      // A key column: the row's first muted segment, or none when the row continues the one above (PLAN's windows).
      // One width in every card, so a card's values start at one x; the key sits on the value's first line.
      const lead = r[0] && r[0].tone === "mute" ? r[0].text.trim() : "";
      const rest = squeeze(lead ? r.slice(1) : r);
      return h_flex().id(`lane-${lane.name}-${i}`).items_start().gap(8).min_w(0)
        .child(div().flex_none().w(KEY_WIDTH).text_color(t.muted).child(lead))
        .child(this.segs(t, c, rest).flex_1());
    });
    return v_flex().id(`lane-${lane.name}`).flex_1().min_w(200).overflow_hidden().gap(LANE_ROW_GAP).p(CARD_PAD).rounded(6).bg(t.raised)
      .child(div().text_size(10.5).font_semibold().text_color(t.muted).child(lane.title.text))
      .children(rows);
  }

  header(t, c, frame) {
    // The title and the lanes in one wrapping row: in a wide pane the lanes sit beside the title, in a narrow one
    // they wrap under it, each still whole.
    // One gap between every card and the title, across and down; the cards of one line stretch to its tallest, their
    // rows from the top.
    const out = [h_flex().flex_wrap().gap(CARD_GAP).items_stretch().child(this.title(t, c, frame)).children(frame.lanes.map((l) => this.lane(t, c, l)))];
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
        ? id.id(`link-${r.id}`).cursor_pointer().hover((s) => s.underline().text_color(t.accent)).on_click((_e, cx) => {
            // The number's own action, not the row's.
            cx.stop_propagation();
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
      const ticket = { project: this.root, id: r.id, shown: r.shown, terminal: r.terminal, bin: binOf(props()?.command) };
      body.push(h_flex().id(`row-${r.id}`).h(28).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => (r.terminal ? peek(r.terminal) : openCard(ticket)))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "sandcastle", kind: "popup", width: 220, props: { menu: ticket } });
        })
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
    if (this.role === "card") return this.renderCard();
    if (this.role === "menu") return this.renderMenu();
    if (this.role === "log") return this.renderLog();
    if (this.role === "bar") return this.renderBar();
    if (this.role === "report") return this.renderReport();
    const t = theme();
    const c = colours(t);
    if (this.role === "line") return this.statusLine(t, c, true);
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
      // Pinned: the root's other rows scroll and give way, the line does not.
      .child(this.statusLine(t, c, false))
      .children(this.header(t, c, frame))
      .child(v_flex().flex_1().min_h(0).children(tbl.parts))
      .children(this.footer(t, c, frame, table, tbl.shown))
      .child(h_flex().text_size(11).child(state));
  }
}
