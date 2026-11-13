// sandcastle: a run's status as a native Herdr app pane (prototype, #871).
//
// The rows are the terminal status view's own: `sandcastle status --json` prints `ticketRows`
// (src/status-rows.ts) of one snapshot, so the two views cannot drift apart. The header is read from
// the run record (`.sandcastle/logs/run.json`) itself, which costs no process.
//
// Liveness: `watchFolder` on `.sandcastle/logs/` wakes a refresh when the run writes anything there
// (no polling), and a slow timer catches what the logs do not show (git, Docker, the queue).
//
// Props: `project` (the project root; default: the focused pane's folder), `command` (the argv that
// prints the rows; default `sandcastle status --json`, a test points it at a fixture's wrapper).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, props, focused, settings } from "herdr";

const DEFAULT_COMMAND = ["sandcastle", "status", "--json"];
// Git, Docker and the queue change without a write under logs/: read them this often regardless.
const SLOW_MS = 15_000;

// The renderer's tones (src/status-rows.ts `Tone`) as theme colours, so the pane follows light and dark.
const toneColour = (t, tone) =>
  ({ head: t.foreground, mute: t.muted, gry: t.dim, hot: t.ansi1, ylw: t.ansi3, cyn: t.ansi6, blu: t.ansi4, grn: t.ansi2 })[tone] ?? t.foreground;

const GROUP_ORDER = ["working", "needs you", "ready", "queued", "blocked", "merged", "later", "left over", "idle"];
const GROUP_TONE = { working: "ylw", "needs you": "hot", ready: "cyn", queued: "blu", blocked: "blu", merged: "grn", later: "gry", "left over": "gry", idle: "gry" };

const hhmm = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
};

const usageWord = (record) => {
  const claude = (record?.usage ?? []).find((u) => u.provider === "claude");
  const w = claude?.windows;
  if (!w) return "";
  return [w.fiveHour && `5h ${w.fiveHour.percent}%`, w.week && `wk ${w.week.percent}%`].filter(Boolean).join(" · ");
};

export default class SandcastleStatus extends View {
  init(_props, cx) {
    this.table = null;
    this.record = null;
    this.error = "";
    this.cost = null; // ms of the last read
    this.reads = 0;
    this.busy = false;
    this.again = false;
    this.refresh(cx);
    cx.timer.every(SLOW_MS, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      const logs = `${this.project()}/.sandcastle/logs`;
      for (;;) {
        try {
          await watchFolder(logs);
        } catch {
          return; // no logs folder (yet): the slow timer still refreshes
        }
        this.refresh(cx);
      }
    });
  }

  project() {
    return props()?.project || focused()?.cwd || "";
  }

  // One read at a time: a burst of log writes while a read runs becomes one more read after it.
  refresh(cx) {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      const root = this.project();
      const [cmd, ...args] = props()?.command ?? DEFAULT_COMMAND;
      const started = Date.now();
      try {
        const [rows, record] = await Promise.all([
          exec(cmd, args, { cwd: root, timeout: 20_000 }),
          readTextFile(`${root}/.sandcastle/logs/run.json`),
        ]);
        this.cost = Date.now() - started;
        this.reads += 1;
        if (rows.code !== 0) throw new Error(rows.stderr.trim().split("\n").pop() || `exit ${rows.code}`);
        this.table = JSON.parse(rows.stdout);
        this.record = record ? JSON.parse(record) : null;
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
      if (this.again) {
        this.again = false;
        this.refresh(cx);
      }
    });
  }

  header(t) {
    const r = this.record ?? {};
    const live = r.pid && !r.finishedAt;
    const s = r.settings ?? {};
    const parts = [
      r.stage ?? (live ? "running" : "ended"),
      s.turn && `turn ${s.turn}${s.cap ? `/${s.cap}` : ""}`,
      r.startedAt && `since ${hhmm(r.startedAt)}`,
      r.tokens,
      usageWord(r),
    ].filter(Boolean);
    return v_flex().gap(4).pb(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded(4).bg(live ? t.working : t.idle))
        .child(div().font_semibold().text_size(14).text_color(t.foreground).child(r.orchestrator ?? "sandcastle"))
        .child(div().text_color(t.muted).text_ellipsis().child(parts.join("  ·  "))))
      .child(h_flex().gap(6).flex_wrap().children(this.chips(t)));
  }

  chips(t) {
    const counts = this.table?.counts ?? {};
    return GROUP_ORDER.filter((g) => counts[g]).map((g) =>
      h_flex().gap(4).px(6).py(1).rounded(4).bg(t.raised).items_center()
        .child(div().text_color(toneColour(t, GROUP_TONE[g])).child(String(counts[g])))
        .child(div().text_color(t.muted).child(g)));
  }

  row(t, mono, r) {
    const cell = (w, text, colour) => div().w(w).flex_none().text_color(colour).whitespace_nowrap().text_ellipsis().child(text);
    return h_flex().id(`row-${r.id}`).gap(10).px(4).py(2).rounded(3).items_center().hover((s) => s.bg(t.hover))
      .font_family(mono)
      .child(cell(14, r.glyph, toneColour(t, r.tone)))
      .child(cell(56, r.shown, t.foreground))
      .child(cell(92, r.state, toneColour(t, r.tone)))
      .child(cell(40, r.time, toneColour(t, r.timeTone)))
      .child(cell(96, r.diff, t.dim))
      .child(cell(84, r.tokens ?? "", t.dim))
      .child(div().flex_1().min_w(0).whitespace_nowrap().text_ellipsis().text_color(toneColour(t, r.noteTone)).child(r.note));
  }

  render(_cx) {
    const t = theme();
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const rows = this.table?.rows ?? [];
    return v_flex().id("root").size_full().bg(t.surface).p(12).gap(8).text_size(12.5)
      .child(this.header(t))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(v_flex().id("rows").flex_1().overflow_y_scrollbar().gap(1)
        .children(rows.map((r) => this.row(t, mono, r))))
      .child(div().text_size(11).text_color(t.dim)
        .child(this.cost == null ? "reading…" : `${rows.length} rows · read ${this.reads}, last in ${this.cost} ms · ${this.project()}`));
  }
}
