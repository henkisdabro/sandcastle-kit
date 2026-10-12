// The status view's frame: a snapshot (src/status-snapshot.ts) and its rows (src/status-rows.ts), at a pane's
// columns and rows, drawn as lines with the grid helpers (src/status-grid.ts). Pure: no process, no file, no
// clock but the snapshot's.
//
// The layout fits the pane, with no fixed breakpoints: the header is the logo and the lanes (GLOSSARY.md) - run,
// machine, models, settings, plan - beside it while it and three of them fit, else in a row under it, and the
// lanes that do not fit on one summary line. The table's fixed columns have set widths and give way in order in
// a narrow pane; ACTIVITY takes the rest.

import { HINT_TEXT } from "./click-hint.ts";
import { align, barsOf, fit, junction as rule, splitColumns, splitWeights, visibleWidth } from "./status-grid.ts";
import { duration, ago, type Row, type Table, type Tone } from "./status-rows.ts";
import { runEnds, shownId, type Snapshot, type SourceName } from "./status-snapshot.ts";
import { USAGE_AMBER, USAGE_RED, USAGE_STALE_SECONDS } from "./usage.ts";

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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
const local = (epoch: number) => new Date(epoch * 1000);
const day = (epoch: number) => {
  const d = local(epoch);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};
const hhmm = (epoch: number) => `${two(local(epoch).getHours())}:${two(local(epoch).getMinutes())}`;
const hhmmss = (epoch: number) => `${hhmm(epoch)}:${two(local(epoch).getSeconds())}`;
/** "13:40" today, "09 Oct 13:40" another day: the run cell has to fit 80 columns. */
const when = (epoch: number, now: number) => (day(epoch) === day(now) ? hhmm(epoch) : `${two(local(epoch).getDate())} ${MONTHS[local(epoch).getMonth()]} ${hhmm(epoch)}`);
/** "13:40" today, "Wed 06:00" another day, the weekday as the usage row has it. */
const weekdayWhen = (epoch: number, now: number) => (day(epoch) === day(now) ? hhmm(epoch) : `${WEEKDAYS[local(epoch).getDay()]} ${hhmm(epoch)}`);

/** An ISO time from a record as epoch seconds, read as UTC with any fraction dropped; 0 when it is none. */
const utcEpoch = (s: string): number => {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(s);
  const t = m ? Date.parse(`${m[1]}Z`) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

/** A field of a record as text the way `jq -r ... | tostring` gives it: none for null and false. */
const text = (v: unknown): string => (v === undefined || v === null || v === false ? "" : typeof v === "string" ? v : JSON.stringify(v));
const digits = (s: string) => /^[0-9]+$/.test(s);

/**
 * Moves each inner bar of `widths` that lies within 4 columns of a bar of the band above (`refs`) onto it, so
 * the two meet in one ┼ rather than a near-miss like ┴┬. `mins` are the least each cell may be (one already
 * narrower keeps its width): a bar whose move would cut a cell stays, and the band still fills the window,
 * the last cell taking the remainder.
 */
export const snap = (widths: number[], refs: number[], mins: number[], win: number): number[] => {
  const n = widths.length;
  const mn = widths.map((w, i) => Math.min(mins[i] ?? 0, w));
  const suf: number[] = Array.from({ length: n + 1 }, () => 0);
  for (let i = n - 1; i >= 0; i--) suf[i] = suf[i + 1]! + mn[i]! + 1;
  const pos: number[] = [];
  let acc = 0;
  let prev = 0;
  for (let i = 0; i < n - 1; i++) {
    acc += widths[i]! + 1;
    const p = acc;
    let best = p;
    let bd = 5;
    for (const r of refs) {
      const d = Math.abs(r - p);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    // A move that cuts this cell or leaves the later ones too little stays put.
    if (best !== p && (best - prev - 1 < mn[i]! || win - 1 - best < suf[i + 1]!)) best = p;
    // An earlier move right may have squeezed this cell.
    if (best < prev + 1 + mn[i]!) best = prev + 1 + mn[i]!;
    pos.push(best);
    prev = best;
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
// A cache share under this is amber: a prompt cache that is not holding costs more than the table says.
const CACHE_AMBER = 70;
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
type Lane = { name: "RUN" | "MACHINE" | "MODELS" | "SETTINGS" | "PLAN"; rows: string[] };

/** The cells a lane needs: its widest row with a cell's padding, and room for its title (`─ RUN ─`). */
const laneNeed = (lane: Lane) => Math.max(...lane.rows.map((r) => visibleWidth(r) + 2), lane.name.length + 4);

/** Draws one frame: its lines, each ending in a newline, as `status 0` prints them. */
export const renderFrame = (snapshot: Snapshot, table: Table, { cols, rows, showAll, colours: c }: FrameOptions): string => {
  const { now, record, live } = snapshot;
  const WIN = cols;
  const kvl = (k: string, v: string) => `${c.mute}${k.padEnd(10)}${c.off}${v}`;
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

  const unpushed = snapshot.unpushed > 0 ? ` ${c.hot}↑${snapshot.unpushed} unpushed${c.off}` : "";
  const clock = hhmmss(now);
  const logoRows = (n: 3 | 1): string[] => {
    const name = snapshot.name;
    const lg =
      n === 3
        ? [
            ` ${c.moon}▄ ▄ ▄${c.off} ${c.star}+${c.off}   ${c.bold}${c.moon}s a n d c a s t l e${c.off} ${c.night}- k i t${c.off}  ${c.star}·   +   ·${c.off}`,
            ` ${c.dusk}█████${c.off}     ${c.head}${name}${c.off}`,
            ` ${c.deep}██▀██${c.off} ${c.star}·${c.off}   ${c.mute}base${c.off} ${c.accent}${snapshot.base}${c.off}${unpushed}  ${c.rule}·${c.off}  ${c.accent}${clock}${c.off}`,
          ]
        : [`${c.bold}${c.moon}sandcastle-kit${c.off}  ${c.head}${name}${c.off}  ${c.mute}base${c.off} ${c.accent}${snapshot.base}${c.off}${unpushed}  ${c.rule}·${c.off}  ${c.accent}${clock}${c.off}`];
    // Each padded to the widest, so centring keeps the castle's shape.
    const m = Math.max(...lg.map(visibleWidth));
    return lg.map((l) => align(l, m));
  };

  // The settings a lane draws from: a live run's, else the next run's, else the last run's.
  const s = snapshot.settings?.settings;
  const mark = snapshot.settings?.from;
  const cross = s ? (s.crossReview === true ? "on" : s.crossReview === false ? "off" : "") : "";

  // RUN: the state and when the run started, its turn (and the estimated end), its tokens.
  const runLane = (): string[] => {
    if (loading("record")) return [`${c.gry}○${c.off} ${c.mute}loading…${c.off}`, "", ""];
    if (!snapshot.hasRecord) return [`${c.gry}○${c.off} ${c.mute}no run recorded yet${c.off}`, "", ""];
    const t0 = utcEpoch(text(record.startedAt));
    const started = when(t0, now);
    const stage = text(record.stage) === "running" ? "" : text(record.stage);
    const dry = record.dryRun ? "dry run" : "";
    const finished = text(record.finishedAt);
    const p = record.paused && typeof record.paused === "object" ? record.paused : undefined;
    const turnCap = s && digits(text(s.cap)) ? text(s.cap) : "";
    const turn = s && digits(text(s.turn)) ? `${c.mute}turn${c.off} ${c.head}${text(s.turn)}${turnCap ? `/${turnCap}` : ""}${c.off}` : "";
    let first: string;
    let second: string[] = [];
    if (finished) first = `${c.gry}○${c.off} ${c.mute}ended (exit ${text(record.exitCode)})${c.off}${dot}${c.mute}started ${started}${c.off}`;
    else if (live && typeof record.stopped === "string" && record.stopped !== "") {
      // The guard stopped the landing: what is in flight still finishes, nothing more lands - and a stop ends a
      // pause, so the lane never reads PAUSED for a run that cannot resume.
      first = `${c.hot}●${c.off} ${c.bold}${c.hot}STOPPED${c.off} ${c.mute}landing${c.off}${dot}${c.mute}${duration(now - t0)}${c.off}${dot}${c.mute}since ${started}${c.off}`;
      second = [`${c.mute}lands nothing more${c.off}`];
    } else if (live && p) [first, second] = pausedRows(p, started);
    else if (live) {
      // The stage says what a run is doing before its first sandbox exists, and after its last: "landing 6/25".
      first = `${c.ylw}● running${c.off}${dry ? ` ${c.accent}${dry}${c.off}` : ""}${dot}${c.mute}${duration(now - t0)}${c.off}${stage ? `${dot}${c.accent}${stage}${c.off}` : ""}${dot}${c.mute}since ${started}${c.off}`;
      const ends = runEnds(record, snapshot.tickets, now);
      if (ends !== undefined) second = [`${c.mute}ends${c.off} ${c.accent}~${hhmm(ends)}${c.off}`];
    } else first = `${c.hot}● killed${c.off}${dot}${c.mute}no clean exit${c.off}${dot}${c.mute}started ${started}${c.off}`;
    // An API key the sandboxes spend: never silent, so red, in words, beside the tokens it bills - the first lane,
    // so it is shown at any width.
    const api = s?.apiKey === true ? `${dot}${c.hot}● API credits${c.off}` : "";
    return [first, [turn, ...second].filter(Boolean).join(dot), `${c.mute}tokens${c.off} ${text(record.tokens) || `${c.gry}-${c.off}`}${api}`];
  };

  // A paused run: `PAUSED since 15:40`, and the tickets that still finish a pass or a landing. A run that paused
  // itself for its plan's usage says what it waits for and when it resumes instead: `PAUSED - weekly usage 95%`.
  const pausedRows = (p: NonNullable<typeof record.paused>, began: string): [string, string[]] => {
    const since = text(p.since ?? 0);
    const at = digits(since) ? (since.length >= 13 ? Math.floor(Number(since) / 1000) : Number(since)) : utcEpoch(since);
    const finishing = Array.isArray(p.finishing) ? p.finishing.map((id) => [String(id), text(snapshot.tickets[String(id)]?.state ?? (record.tickets?.[String(id)] as { state?: unknown } | undefined)?.state)] as const) : [];
    const list = finishing
      .map(([id, st]) => {
        const word = st === "implement" ? "impl" : st === "cross-review" ? "codex" : st === "ready" ? "landing" : st;
        return `${shownId(id)}${word ? ` ${word}` : ""}`;
      })
      .join(", ");
    const rest = list ? `${c.mute}finishing${c.off} ${c.head}${list}${c.off}` : `${c.mute}started ${began}${c.off}`;
    const usage = p.cause === "usage" && (p.window === "fiveHour" || p.window === "week") && typeof p.percent === "number" && typeof p.resumesAt === "number";
    if (usage) {
      const percent = Math.max(Math.min(Math.floor(p.percent!), 100), 0);
      let what = p.window === "fiveHour" ? "5-hour" : "weekly";
      if (p.provider === "codex") what = `Codex ${what}`;
      return [`${c.bold}${c.ylw}● PAUSED${c.off} ${c.mute}- ${what} usage ${percent}%${c.off}`, [`${c.mute}resumes ${weekdayWhen(Math.floor(p.resumesAt!), now)}${c.off}`, rest]];
    }
    return [`${c.bold}${c.ylw}● PAUSED${c.off} ${c.mute}since ${when(at, now)}${c.off}`, [rest]];
  };

  // MACHINE: the pool's slots, and what this run wants of it or the gates queue.
  const gauge = (used: number, limit: string) => {
    let g = "";
    if (digits(limit) && Number(limit) <= 12) g = `${c.ylw}${rep("█", used)}${c.rule}${rep("░", Number(limit) - used)}${c.off} `;
    return `${g}${c.head}${used}/${limit}${c.off}`;
  };
  const gateWait = live ? Object.values(snapshot.tickets).filter((t) => t.state === "gates" && typeof t.note === "string" && t.note.startsWith("waiting for")).length : 0;
  const MAC = [kvl("sandboxes", gauge(snapshot.pool.sandboxes.used, snapshot.pool.sandboxes.limit)), "", ""];
  const demand = text(record.demand);
  const share = text(record.share);
  const cap = text(record.cap);
  if (live && digits(demand) && digits(share)) {
    // This run's demand and share take the third row, so the gates queue moves onto the gates row.
    MAC[1] = kvl("gates", gauge(snapshot.pool.gates.used, snapshot.pool.gates.limit) + (gateWait > 0 ? ` ${c.hot}· ${gateWait} waiting${c.off}` : ""));
    MAC[2] = kvl("this run", `${c.head}wants ${demand}${c.gry} · share ${c.head}${share}${c.off}${digits(cap) ? `${c.gry} · cap ${c.head}${cap}${c.off}` : ""}`);
  } else {
    MAC[1] = kvl("gates", gauge(snapshot.pool.gates.used, snapshot.pool.gates.limit));
    MAC[2] = gateWait > 0 ? kvl("waiting", `${c.hot}${gateWait} for a gates slot${c.off}`) : kvl("waiting", `${c.gry}none${c.off}`);
  }

  // MODELS: implement, review, and the repair attempts the settings give. The ids lose their `claude-` prefix
  // here; `sandcastle report` keeps the full ones.
  let models = snapshot.models;
  let mprefix = "";
  const prefixed = /^(next run|last run): /.exec(models);
  if (prefixed) {
    mprefix = prefixed[1]!;
    models = models.slice(prefixed[0].length);
  }
  // A record that carries cross-review as a setting shows it in the settings lane, so the models drop that part.
  if ((cross === "on" || cross === "off") && models.includes(" · cross-review ")) {
    const cut = models.indexOf(" · cross-review ");
    const after = models.slice(cut + " · cross-review ".length);
    models = models.slice(0, cut) + (after.includes(" · ") ? ` · ${after.slice(after.indexOf(" · ") + 3)}` : "");
  }
  const kv6 = (k: string, v: string) => `${c.mute}${k.padEnd(6)}${c.off} ${v}`;
  const modelItems = models
    ? models.split(" · ").map((item) => {
        const space = item.indexOf(" ");
        const label = space < 0 ? item : item.slice(0, space);
        const value = space < 0 ? "" : item.slice(space + 1).replace(/(^|[\s,])claude-/g, "$1");
        return kv6(label === "implement" ? "impl" : label, `${c.head}${value}${c.off}`);
      })
    : [];
  const repair = s ? text(s.repair) : "";
  const MOD = [
    modelItems[0] ? `${modelItems[0]}${mprefix ? ` ${c.gry}(${mprefix})${c.off}` : ""}` : "",
    modelItems.slice(1).join(dot),
    // Repair off is greyed, with the ○ that says so without colour.
    digits(repair) ? (Number(repair) === 0 ? `${c.gry}○ repair${c.off}` : kv6("repair", `${c.head}${repair}${c.off}`)) : "",
  ];

  // SETTINGS: autonomy, concurrency, cross-review and the usage guard - the turn is in RUN, repair in MODELS.
  const SET = ["", "", ""];
  if (s) {
    const lvl = text(s.autonomy);
    if (["0", "1", "2", "3", "drain"].includes(lvl)) SET[0] = `${c.mute}autonomy${c.off} ${c.bold}${c.accent}[${lvl}]${c.off}`;
    // Concurrency as the run takes it after the machine-wide cap; what it asked for only when that differs.
    const conc = text(s.concurrency);
    if (digits(conc)) {
      const asked = text(s.asked);
      SET[1] = `${c.mute}concurrency${c.off} ${c.head}${conc}${c.off}${digits(asked) && Number(asked) !== Number(conc) ? ` ${c.gry}(asked ${asked})${c.off}` : ""}`;
    }
    const guards: string[] = [];
    // The record is a file in a repository: a model or effort that is not plain text is left out of the terminal.
    if (cross === "on") {
      const model = /^[A-Za-z0-9._:/-]+$/.test(text(s.crossReviewModel)) ? text(s.crossReviewModel) : "";
      const effort = ["low", "medium", "high", "xhigh"].includes(text(s.crossReviewEffort)) ? text(s.crossReviewEffort) : "";
      guards.push(`${c.accent}●${c.off} ${c.mute}cross-review${c.off}${model ? ` ${c.head}${model}${effort ? ` ${effort}` : ""}${c.off}` : ""}`);
    } else if (cross === "off") guards.push(`${c.gry}○ cross-review${c.off}`);
    // The usage guard: a lost reading is a fact beside the setting, in the warning colour.
    const stop = digits(text(s.usageStop)) ? text(s.usageStop) : "";
    const guard = s.usageGuard === undefined || s.usageGuard === null ? "" : typeof s.usageGuard === "string" ? s.usageGuard : JSON.stringify(s.usageGuard);
    if (guard === "true") {
      if (text(s.usageReading) === "unavailable") guards.push(`${c.ylw}● usage-guard${stop ? ` ${stop}%` : ""} (no reading - not guarding)${c.off}`);
      else guards.push(`${c.grn}●${c.off} ${c.mute}usage-guard${c.off}${stop ? ` ${c.head}${stop}%${c.off}` : ""}`);
    } else if (guard === "false") guards.push(`${c.gry}○ usage-guard${c.off}`);
    if (digits(text(s.usagePause))) guards.push(`${c.grn}●${c.off} ${c.mute}usage-pause${c.off} ${c.head}${text(s.usagePause)}%${c.off}`);
    SET[2] = guards.join(dot);
    // The next run's settings are not the ended run's: "next run:" leads the lane, "(last run)" ends it.
    const firstRow = SET.findIndex(Boolean);
    if (firstRow >= 0 && mark === "next run") SET[firstRow] = `${c.gry}next run:${c.off} ${SET[firstRow]}`;
    const lastRow = SET.findLastIndex(Boolean);
    if (lastRow >= 0 && mark === "last run") SET[lastRow] = `${SET[lastRow]} ${c.gry}(last run)${c.off}`;
  }

  // PLAN: a live run's plan usage, both windows of each provider with a reading; left out without one.
  const PLAN: string[] = [];
  if (live) {
    const settingsGroup = record.settings && typeof record.settings === "object" ? record.settings : {};
    const entries = (Array.isArray(record.usage) ? record.usage : record.usage && typeof record.usage === "object" ? [record.usage] : []).filter(
      (u) => u && typeof u === "object" && ((u.provider === "claude" && settingsGroup.apiKey !== true) || (u.provider === "codex" && settingsGroup.crossReview !== false)),
    );
    const readings: string[][] = [];
    for (const u of entries) {
      const num = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.floor(v) : undefined);
      const p5 = num(u.windows?.fiveHour?.percent);
      const r5 = num(u.windows?.fiveHour?.resetsAt);
      const pw = num(u.windows?.week?.percent);
      const rw = num(u.windows?.week?.resetsAt);
      const at = num(u.at);
      if (p5 === undefined || r5 === undefined || pw === undefined || rw === undefined || at === undefined) continue;
      const age = Math.max(now - at, 0);
      // A stale reading is greyed, its age beside it.
      const grey = age > USAGE_STALE_SECONDS;
      const window = (label: string, percent: number, resets: string) => {
        const pct = Math.min(percent, 100);
        const tone = grey ? c.gry : pct >= USAGE_RED ? c.hot : pct >= USAGE_AMBER ? c.ylw : c.head;
        let filled = Math.floor((pct + 10) / 20);
        if (pct > 0 && filled === 0) filled = 1;
        return `${c.mute}${label.padEnd(4)}${c.off} ${tone}${rep("▓", filled)}${c.gry}${rep("░", 5 - filled)}${c.off} ${tone}${String(pct).padStart(3)}%${c.off} ${c.mute}· resets ${resets}${c.off}`;
      };
      readings.push([`${c.mute}${u.provider.padEnd(6)}${c.off} ${window("5h", p5, hhmm(r5))}`, window("week", pw, `${WEEKDAYS[local(rw).getDay()]} ${hhmm(rw)}`), `${c.mute}(${ago(age)} ago)${c.off}`]);
    }
    // One provider takes a row for each window; two take a row each.
    if (readings.length === 1) PLAN.push(readings[0]![0]!, `${rep(" ", 7)}${readings[0]![1]}`, `${rep(" ", 7)}${readings[0]![2]}`);
    else for (const r of readings) PLAN.push(r.join(dot));
  }

  // The lanes, in priority order: the first that do not fit fold into the summary line.
  const lanes: Lane[] = [{ name: "RUN", rows: runLane() }, { name: "MACHINE", rows: MAC }];
  if (MOD.some(Boolean)) lanes.push({ name: "MODELS", rows: MOD });
  if (SET.some(Boolean)) lanes.push({ name: "SETTINGS", rows: SET });
  if (PLAN.length) lanes.push({ name: "PLAN", rows: PLAN });
  const needs = lanes.map(laneNeed);
  const fits = (widths: number[]) => widths.reduce((a, b) => a + b, 0) + widths.length + 1 <= WIN;

  // A rule whose cells starting at `titles`' columns carry the lane's name: `┬─ RUN ───`.
  const titled = (left: string, right: string, down: number[], titles: { x: number; name: string }[]) => {
    const plain = rule(WIN, left, right, "─", [], down);
    let out = "";
    let at = 0;
    for (const t of titles) {
      out += `${c.rule}${plain.slice(at, t.x + 2)}${c.off} ${c.bold}${c.head}${t.name}${c.off} `;
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
        // A row's padding is the band's: one space apart in the line, none leading (after any colour code).
        // oxlint-disable-next-line no-control-regex -- the escape byte is what the pattern skips
        const items = lane.rows.map((r) => r.replace(/ {2,}/g, " ").replace(/^((?:\x1b\[[0-9;]*m)*) /, "$1")).filter((r) => visibleWidth(r) > 0);
        return `${c.mute}${lane.name.toLowerCase()}${c.off}  ${items.join(dot)}`;
      })
      .join(`${c.rule} │ ${c.off}`);

  const header = (logo: 3 | 1): { lines: string[]; band: boolean } => {
    const out: string[] = [];
    const LG = logoRows(logo);
    const logoNeed = visibleWidth(LG[0]!) + 2;
    let bars: number[] = [];
    let shown = 0;
    const beside = fits([logoNeed, ...needs.slice(0, Math.min(3, lanes.length))]);
    if (beside) {
      // Beside the logo: the lanes that fit, in order, after it.
      shown = Math.min(3, lanes.length);
      while (shown < lanes.length && fits([logoNeed, ...needs.slice(0, shown + 1)])) shown++;
      const widths = spread([logoNeed, ...needs.slice(0, shown)]);
      bars = barsOf(widths);
      out.push(titled("┌", "┐", bars, lanes.slice(0, shown).map((lane, i) => ({ x: bars[i]!, name: lane.name }))));
      const logoAt = logo === 3 ? LG : ["", LG[0]!, ""];
      for (let i = 0; i < 3; i++) out.push(line(widths, [logoAt[i] ?? "", ...lanes.slice(0, shown).map((lane) => lane.rows[i] ?? "")], ["c", ...lanes.map(() => "l")]));
    } else {
      // The logo on a band of its own, the lanes that fit in a row beneath it.
      out.push(junction("┌", "┐", [], []));
      for (const l of LG) out.push(line([WIN - 2], [l], ["c"]));
      while (shown < lanes.length && fits(needs.slice(0, shown + 1))) shown++;
      if (shown > 0) {
        const widths = spread(needs.slice(0, shown));
        bars = barsOf(widths);
        out.push(titled("├", "┤", bars, lanes.slice(0, shown).map((lane, i) => ({ x: i === 0 ? 0 : bars[i - 1]!, name: lane.name }))));
        for (let i = 0; i < 3; i++) out.push(line(widths, lanes.slice(0, shown).map((lane) => lane.rows[i] ?? ""), lanes.map(() => "l")));
      }
    }
    const one = [WIN - 2];
    if (shown < lanes.length) {
      out.push(junction("├", "┤", bars, []));
      out.push(line(one, [summary(lanes.slice(shown))], ["l"]));
      bars = [];
    }
    // An unreadable queue is not an empty one, and neither is one still being read: say so, under the band.
    const queueNote = loading("queue") ? "queue: loading…" : snapshot.queue.error ? `queue: could not read - ${snapshot.queue.error}` : "";
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

  // The legend, each group with its count, then the notes.
  const n = table.counts;
  const LEG = [
    `${c.ylw}● working ${c.bold}${n.working}${c.off}`,
    `${c.hot}! needs you ${c.bold}${n["needs you"]}${c.off}`,
    `${c.cyn}> ready to land ${c.bold}${n.ready}${c.off}`,
    `${c.blu}○ queued ${c.bold}${n.queued}${c.off}`,
    `${c.blu}~ blocked ${c.bold}${n.blocked}${c.off}`,
    `${c.grn}+ merged ${c.bold}${n.merged}${c.off}`,
  ];
  // Tickets outside the live run, a group of their own: queued and blocked count the run's alone.
  if (n.later > 0) LEG.push(`${c.gry}… later ${c.bold}${n.later}${c.off}`);
  LEG.push(`${c.gry}- left over ${c.bold}${n["left over"]}${c.off}`, `${c.gry}· idle ${c.bold}${n.idle}${c.off}`);
  const NOTE: string[] = [];
  // The view reads git, not the agents' notes: the closing summary counts a merged ticket left open under "needs you".
  if (table.partly > 0) NOTE.push(`${c.gry}${table.partly} merged, partly done (ticket open)${c.off}`, `${c.gry}the closing summary counts it under needs you${c.off}`);
  NOTE.push(`${c.gry}ready = gates green, waits for the landing worker${c.off}`, `${c.gry}time = in state, ~ roughly what it usually has left; once finished, start to end${c.off}`, `${c.gry}red time = past twice the usual${c.off}`);
  if (has("TOKENS")) NOTE.push(`${c.gry}tokens = in, % of it from cache (amber under ${CACHE_AMBER}%), out${c.off}`);
  if (has("CPU/MEM")) NOTE.push(`${c.gry}CPU in cores of ${snapshot.cpus}${c.off}`);
  if (snapshot.links) NOTE.push(`${c.gry}${HINT_TEXT[snapshot.clickMod === "ctrl" || snapshot.clickMod === "cmd" ? snapshot.clickMod : "fallback"]}${c.off}`);
  // Cells as wide as their text needs: every item on one row from 130 columns where they fit (halved until they
  // do), else rows of four, or of two where four do not fit.
  let per = cols < 130 ? 4 : LEG.length;
  let LWT: number[];
  for (;;) {
    LWT = [];
    for (let col = 0; col < per; col++) {
      let w = 0;
      for (let r = col; r < LEG.length; r += per) w = Math.max(w, visibleWidth(LEG[r]!));
      LWT.push(w + 4);
    }
    if (per <= 2 || LWT.reduce((a, b) => a + b, 0) + per + 1 <= WIN) break;
    per = Math.floor((per + 1) / 2);
  }
  // The legend's bars snap onto the table's, so the seam between them has no near-miss joints.
  const lw = snap(splitColumns(WIN, LWT), tbars, LWT, WIN);
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
