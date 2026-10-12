// The status view's frame: a snapshot (src/status-snapshot.ts) and its rows (src/status-rows.ts), at a pane's
// columns and rows, drawn as lines with the grid helpers (src/status-grid.ts). Pure: no process, no file, no
// clock but the snapshot's.
//
// The plain frame of the tracer bullet (#704): status.sh's stacked header - the logo, the run and machine cells,
// the models, the settings and usage rows, a queue that could not be read - and its table and legend, so the
// frame carries the same facts in the same words. The new layout comes later (#695).

import { HINT_TEXT } from "./click-hint.ts";
import { align, barsOf, fit, junction as rule, splitColumns, splitWeights, visibleWidth } from "./status-grid.ts";
import { duration, ago, type Row, type Table, type Tone } from "./status-rows.ts";
import { logTicket, runEnds, shownId, type Snapshot } from "./status-snapshot.ts";
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

/** An ISO time from a record as epoch seconds, read as UTC with any fraction dropped (status.sh `utc_to_epoch`); 0 when it is none. */
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
 * the last cell taking the remainder. status.sh `snap_w`.
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

/** Draws one frame: its lines, each ending in a newline, as `status 0` prints them. */
export const renderFrame = (snapshot: Snapshot, table: Table, { cols, rows, showAll, colours: c }: FrameOptions): string => {
  const { now, record, live } = snapshot;
  const WIN = cols;
  const kvl = (k: string, v: string) => `${c.mute}${k.padEnd(10)}${c.off}${v}`;
  const line = (widths: number[], cells: string[], aligns: string[]) =>
    `${c.rule}│${c.off}` + widths.map((w, i) => ` ${align(cells[i] ?? "", w - 2, (aligns[i] ?? "l") as "l" | "c" | "r")} ${c.rule}│${c.off}`).join("");
  const junction = (left: string, right: string, up: number[], down: number[]) => `${c.rule}${rule(WIN, left, right, "─", up, down)}${c.off}`;
  const rep = (ch: string, n: number) => ch.repeat(Math.max(n, 0));

  // The table's columns: the fixed ones a share of the pane (with a minimum each), ACTIVITY the rest. TICKET fits
  // the longest ticket shown, up to 16, and never narrower than its heading. In a narrow pane CPU/MEM gives its
  // width to ACTIVITY, where the notes are; below 80 columns TOKENS does too.
  const named = [...snapshot.logs.map((l) => logTicket(l.name) ?? ""), ...snapshot.queue.tickets.map((t) => t.id), ...(live ? Object.keys(snapshot.tickets) : [])];
  const longest = Math.min(Math.max(6, ...named.filter(Boolean).map((id) => [...shownId(id)].length)), 16);
  const wide = cols < 80 ? 0 : cols < 100 ? 1 : 2;
  const [MIN, PCT] =
    wide === 2 ? [[longest + 2, 15, 7, 9, 13, 12], [6, 9, 5, 6, 8, 7]] : wide === 1 ? [[longest + 2, 15, 7, 9, 12], [6, 9, 5, 6, 7]] : [[longest + 2, 12, 7, 9], [6, 9, 5, 6]];
  const avail = cols - MIN.length - 2;
  const TW = MIN.map((m, i) => Math.max(Math.floor((avail * PCT[i]!) / 100), m));
  TW.push(Math.max(avail - TW.reduce((a, b) => a + b, 0), 10));
  // Every column but STATE and ACTIVITY is centred.
  const TAL = ["c", "l", "c", "c", "c", "c"];
  TAL[MIN.length] = "l";
  const tbars = barsOf(TW);

  // The rows' cells.
  const paint = (tone: Tone) => c[tone];
  const cellsOf = (r: Row): string[] => {
    let id = `${c.bold}${c.wht}${r.shown}${c.off}`;
    if (r.link) id = `\x1b]8;;file://${r.link}\x1b\\${id}\x1b]8;;\x1b\\`;
    const cells = [id, `${paint(r.tone)}${r.glyph} ${r.state}${c.off}`, `${paint(r.timeTone)}${r.time}${c.off}`, `${r.commits === "-" ? c.gry : c.head}${r.commits}${c.off}`];
    if (wide === 2) cells[4] = r.cpu ? `${r.cpu.hot ? c.hot : c.head}${r.cpu.cpu}${c.off}${c.head}/${r.cpu.mem}${c.off}` : `${c.gry}-${c.off}`;
    if (wide >= 1) cells[wide + 3] = r.tokens ? `${c.head}${r.tokens}${c.off}` : `${c.gry}-${c.off}`;
    cells[TW.length - 1] = `${paint(r.noteTone)}${r.note}${c.off}`;
    return cells;
  };

  // The run cell's three rows.
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
  // The wide header's cells (from 170 columns): the logo cell takes what the logo needs in either of its forms,
  // so the run cell's width does not change with the pane's height; the run, machine and models share the rest.
  const wideSplit = (): number[] => {
    const lw = Math.max(visibleWidth(logoRows(3)[0]!), visibleWidth(logoRows(1)[0]!)) + 2;
    return [lw, ...splitWeights(WIN - 5 - lw, [1, 1, 1])];
  };

  const runCell = (): string[] => {
    const runc = ["", "", ""];
    if (!snapshot.hasRecord) {
      runc[0] = kvl("state", `${c.mute}no run recorded yet${c.off}`);
      return runc;
    }
    const t0 = utcEpoch(text(record.startedAt));
    const started = when(t0, now);
    const stage = text(record.stage) === "running" ? "" : text(record.stage);
    const dry = record.dryRun ? "dry run" : "";
    const finished = text(record.finishedAt);
    const p = record.paused && typeof record.paused === "object" ? record.paused : undefined;
    if (finished) {
      runc[0] = kvl("state", `${c.mute}ended (exit ${text(record.exitCode)})${c.off}`);
      runc[1] = kvl("started", `${c.mute}${started}${c.off}`);
    } else if (live && typeof record.stopped === "string" && record.stopped !== "") {
      // The guard stopped the landing: what is in flight still finishes, nothing more lands - and a stop ends a
      // pause, so the cell never reads PAUSED for a run that cannot resume.
      runc[0] = kvl("state", `${c.bold}${c.hot}STOPPED${c.off} ${c.mute}landing · ${duration(now - t0)}${c.off}`);
      runc[1] = kvl("since", `${c.mute}${started} · lands nothing more${c.off}`);
    } else if (live && p) {
      pausedCell(runc, p, started);
    } else if (live) {
      // The stage says what a run is doing before its first sandbox exists, and after its last: "landing 6/25".
      runc[0] = kvl("state", `${c.ylw}running${c.off}${dry ? ` ${c.accent}${dry}${c.off}` : ""} ${c.mute}· ${duration(now - t0)}${c.off}${stage ? ` ${c.rule}·${c.off} ${c.accent}${stage}${c.off}` : ""}`);
      const ends = runEnds(record, snapshot.tickets, now);
      runc[1] = ends !== undefined ? kvl("ends", `${c.accent}~${hhmm(ends)}${c.off} ${c.mute}· since ${started}${c.off}`) : kvl("since", `${c.mute}${started}${c.off}`);
    } else {
      runc[0] = kvl("state", `${c.hot}killed${c.off} ${c.mute}· no clean exit${c.off}`);
      runc[1] = kvl("started", `${c.mute}${started}${c.off}`);
    }
    runc[2] = kvl("tokens", text(record.tokens) || `${c.gry}-${c.off}`);
    return runc;
  };

  // A paused run: `PAUSED since 15:40 - finishing #12 review` while tickets still finish a pass or a landing, the
  // tickets on the second row when the pane is too narrow. A run that paused itself for its plan's usage says
  // what it waits for and when it resumes instead: `PAUSED - weekly usage 95%, resumes Wed 06:01`.
  const pausedCell = (runc: string[], p: NonNullable<typeof record.paused>, began: string) => {
    const since = text(p.since ?? 0);
    const at = digits(since) ? (since.length >= 13 ? Math.floor(Number(since) / 1000) : Number(since)) : utcEpoch(since);
    const pausedAt = when(at, now);
    const finishing = Array.isArray(p.finishing) ? p.finishing.map((id) => [String(id), text(snapshot.tickets[String(id)]?.state ?? (record.tickets?.[String(id)] as { state?: unknown } | undefined)?.state)] as const) : [];
    const list = finishing
      .map(([id, st]) => {
        const word = st === "implement" ? "impl" : st === "cross-review" ? "codex" : st === "ready" ? "landing" : st;
        return `${shownId(id)}${word ? ` ${word}` : ""}`;
      })
      .join(", ");
    const plainText = `PAUSED since ${pausedAt}`;
    // The cell's text room: half the pane below 170 columns, from there the wide header's run cell, less padding and label.
    const room = cols >= 170 ? wideSplit()[1]! - 12 : Math.floor((cols - 3) / 2) - 12;
    const usage = p.cause === "usage" && (p.window === "fiveHour" || p.window === "week") && typeof p.percent === "number" && typeof p.resumesAt === "number";
    if (usage) {
      const percent = Math.max(Math.min(Math.floor(p.percent!), 100), 0);
      const resumes = Math.floor(p.resumesAt!);
      let what = p.window === "fiveHour" ? "5-hour" : "weekly";
      if (p.provider === "codex") what = `Codex ${what}`;
      what = `${what} usage ${percent}%`;
      const back = weekdayWhen(resumes, now);
      // Shorter and shorter until the state fits its row: the whole line, then the window, then only that it is usage.
      if (9 + what.length + 10 + back.length <= room) {
        runc[0] = kvl("state", `${c.bold}${c.ylw}PAUSED${c.off} ${c.mute}- ${what}, resumes ${back}${c.off}`);
        runc[1] = list ? kvl("finishing", `${c.head}${list}${c.off}`) : kvl("since", `${c.mute}${began}${c.off}`);
      } else {
        if (9 + what.length > room) what = `usage ${percent}%`;
        runc[0] = kvl("state", `${c.bold}${c.ylw}PAUSED${c.off} ${c.mute}- ${what}${c.off}`);
        runc[1] = kvl("resumes", `${c.mute}${back}${c.off}`);
      }
      return;
    }
    if (list && plainText.length + 13 + list.length <= room) {
      runc[0] = kvl("state", `${c.bold}${c.ylw}PAUSED${c.off} ${c.mute}since ${pausedAt} - finishing${c.off} ${c.head}${list}${c.off}`);
      runc[1] = kvl("since", `${c.mute}${began}${c.off}`);
    } else {
      runc[0] = kvl("state", `${c.bold}${c.ylw}PAUSED${c.off} ${c.mute}since ${pausedAt}${c.off}`);
      runc[1] = list ? kvl("finishing", `${c.head}${list}${c.off}`) : kvl("since", `${c.mute}${began}${c.off}`);
    }
  };

  // The machine cell: the pool's slots, and what this run wants of it or the gates queue.
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

  // The settings row: a live run's, else the next run's, else the last run's; a field the source lacks is left out.
  const settingsRows: string[] = [];
  const s = snapshot.settings?.settings;
  const cross = s ? (s.crossReview === true ? "on" : s.crossReview === false ? "off" : "") : "";
  if (s) {
    const items: string[] = [];
    const item = (full: string, narrow = "", min = 0) => {
      if (cols < min) return;
      items.push(cols >= 100 ? full : narrow || full);
    };
    const lvl = text(s.autonomy);
    if (["0", "1", "2", "3", "drain"].includes(lvl)) {
      const levels = ["0", "1", "2", "3", "drain"].map((l) => (l === lvl ? ` ${c.bold}${c.accent}[${l}]${c.off}` : ` ${c.gry}${l}${c.off}`)).join("");
      item(`${c.mute}autonomy${c.off}${levels}`, `${c.mute}autonomy${c.off} ${c.bold}${c.accent}${lvl}${c.off}`);
    }
    const turnCap = digits(text(s.cap)) ? text(s.cap) : "";
    if (digits(text(s.turn))) item(`${c.mute}turn${c.off} ${c.head}${text(s.turn)}${turnCap ? `/${turnCap}` : ""}${c.off}`);
    // Repair off is greyed, with the ○ that says so without colour, and drops below 80 columns.
    const repair = text(s.repair);
    if (digits(repair)) {
      if (Number(repair) === 0) item(`${c.gry}○ repair${c.off}`, "", 80);
      else item(`${c.mute}repair${c.off} ${c.head}${repair}${c.off}`);
    }
    // Concurrency as the run takes it after the machine-wide cap; what it asked for only when that differs.
    const conc = text(s.concurrency);
    if (digits(conc)) {
      const asked = text(s.asked);
      item(`${c.mute}concurrency${c.off} ${c.head}${conc}${c.off}${digits(asked) && Number(asked) !== Number(conc) ? ` ${c.gry}(asked ${asked})${c.off}` : ""}`);
    }
    // The record is a file in a repository: a model or effort that is not plain text is left out of the terminal.
    if (cross === "on") {
      const model = /^[A-Za-z0-9._:/-]+$/.test(text(s.crossReviewModel)) ? text(s.crossReviewModel) : "";
      const effort = ["low", "medium", "high", "xhigh"].includes(text(s.crossReviewEffort)) ? text(s.crossReviewEffort) : "";
      item(`${c.accent}●${c.off} ${c.mute}cross-review${c.off}${model ? ` ${c.head}${model}${effort ? ` ${effort}` : ""}${c.off}` : ""}`);
    } else if (cross === "off") item(`${c.gry}○ cross-review${c.off}`, "", 80);
    // The usage guard: a lost reading is a fact beside the setting, in the warning colour, at any width.
    const stop = digits(text(s.usageStop)) ? text(s.usageStop) : "";
    const guard = s.usageGuard === undefined || s.usageGuard === null ? "" : typeof s.usageGuard === "string" ? s.usageGuard : JSON.stringify(s.usageGuard);
    if (guard === "true") {
      if (text(s.usageReading) === "unavailable") item(`${c.ylw}● usage-guard${stop ? ` ${stop}%` : ""} (no reading - not guarding)${c.off}`);
      else item(`${c.grn}●${c.off} ${c.mute}usage-guard${c.off}${stop ? ` ${c.head}${stop}%${c.off}` : ""}`);
    } else if (guard === "false") item(`${c.gry}○ usage-guard${c.off}`, "", 80);
    if (digits(text(s.usagePause))) item(`${c.grn}●${c.off} ${c.mute}usage-pause${c.off} ${c.head}${text(s.usagePause)}%${c.off}`);
    // An API key the sandboxes spend: never silent, so red, in words, at any width.
    if (s.apiKey === true) item(`${c.hot}● API credits (ANTHROPIC_API_KEY)${c.off}`, `${c.hot}● API credits${c.off}`);
    if (items.length) {
      const mark = snapshot.settings!.from;
      // The next run's settings are not the ended run's: "next run:" leads the whole row.
      if (mark === "next run") items[0] = `${c.gry}next run:${c.off} ${items[0]}`;
      const wrapped = wrapItems(cols - 14, items, `${c.rule} · ${c.off}`);
      if (mark === "last run") {
        // The mark ends the last line, or stands on a line of its own when that would cut the line.
        const n = wrapped.length - 1;
        if (visibleWidth(`${wrapped[n]} (last run)`) <= cols - 14) wrapped[n] = `${wrapped[n]} ${c.gry}(last run)${c.off}`;
        else wrapped.push(`${c.gry}(last run)${c.off}`);
      }
      settingsRows.push(kvl("settings", wrapped[0]!), ...wrapped.slice(1).map((w) => `          ${w}`));
    }
  }

  // The plan's usage, a line for each provider a live run shows: both windows beside the reading's age.
  if (live) {
    const settingsGroup = record.settings && typeof record.settings === "object" ? record.settings : {};
    const entries = (Array.isArray(record.usage) ? record.usage : record.usage && typeof record.usage === "object" ? [record.usage] : []).filter(
      (u) => u && typeof u === "object" && ((u.provider === "claude" && settingsGroup.apiKey !== true) || (u.provider === "codex" && settingsGroup.crossReview !== false)),
    );
    let n = 0;
    for (const u of entries) {
      const num = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.floor(v) : undefined);
      let p5 = num(u.windows?.fiveHour?.percent);
      const r5 = num(u.windows?.fiveHour?.resetsAt);
      let pw = num(u.windows?.week?.percent);
      const rw = num(u.windows?.week?.resetsAt);
      const at = num(u.at);
      const name = u.provider.padEnd(6);
      let items: string[];
      if (p5 !== undefined && r5 !== undefined && pw !== undefined && rw !== undefined && at !== undefined) {
        p5 = Math.min(p5, 100);
        pw = Math.min(pw, 100);
        const age = Math.max(now - at, 0);
        // A stale reading is greyed, its age beside it.
        const grey = age > USAGE_STALE_SECONDS;
        const window = (label: string, pct: number, resets: string) => {
          const tone = grey ? c.gry : pct >= USAGE_RED ? c.hot : pct >= USAGE_AMBER ? c.ylw : c.head;
          let filled = Math.floor((pct + 5) / 10);
          if (pct > 0 && filled === 0) filled = 1;
          return `${c.mute}${label}${c.off} ${tone}${rep("▓", filled)}${c.gry}${rep("░", 10 - filled)}${c.off} ${tone}${pct}%${c.off} ${c.mute}· resets ${resets}${c.off}`;
        };
        const fiveHour = window("5h", p5, hhmm(r5));
        const week = window("week", pw, `${WEEKDAYS[local(rw).getDay()]} ${hhmm(rw)}`);
        items = [`${c.mute}${name}${c.off}  ${fiveHour}`, week, `${c.mute}(${ago(age)} ago)${c.off}`];
      } else {
        // Claude's reading comes from any agent's stream, Codex's from the cross-review pass's.
        items = [`${c.mute}${name}${c.off}  ${c.gry}waiting for the first ${u.provider === "codex" ? "cross-review's" : "agent's"} reading${c.off}`];
      }
      const wrapped = wrapItems(cols - 14, items, "   ");
      settingsRows.push(n === 0 ? kvl("usage", wrapped[0]!) : `          ${wrapped[0]}`, ...wrapped.slice(1).map((w) => `          ${w}`));
      n++;
    }
  }

  // The models: "implement X · review Y", a row each in the wide header's models cell.
  let models = snapshot.models;
  let mprefix = "";
  const prefixed = /^(next run|last run): /.exec(models);
  if (prefixed) {
    mprefix = prefixed[1]!;
    models = models.slice(prefixed[0].length);
  }
  // A record that carries cross-review as a setting shows it in the settings row, so the models drop that part.
  if ((cross === "on" || cross === "off") && models.includes(" · cross-review ")) {
    const cut = models.indexOf(" · cross-review ");
    const after = models.slice(cut + " · cross-review ".length);
    models = models.slice(0, cut) + (after.includes(" · ") ? ` · ${after.slice(after.indexOf(" · ") + 3)}` : "");
  }
  const MOD = models
    ? models
        .split(" · ")
        .slice(0, 3)
        .map((item) => (item.includes(" ") ? kvl(item.slice(0, item.indexOf(" ")), `${c.head}${item.slice(item.indexOf(" ") + 1)}${c.off}`) : kvl(item, "")))
    : [];
  if (mprefix && MOD[0]) MOD[0] = `${MOD[0]} ${c.gry}(${mprefix})${c.off}`;

  const RUNC = runCell();
  const header = (logo: 3 | 1): string[] => {
    const out: string[] = [];
    const LG = logoRows(logo);
    const m = visibleWidth(LG[0]!);
    let bars: number[];
    if (cols >= 170) {
      // Wide: the logo, the run, the machine and the models side by side, no cell narrower than its widest row.
      const need = [m + 2, 0, 0, 0];
      for (let i = 0; i < 3; i++) {
        need[1] = Math.max(need[1]!, visibleWidth(RUNC[i] ?? "") + 2);
        need[2] = Math.max(need[2]!, visibleWidth(MAC[i] ?? "") + 2);
        need[3] = Math.max(need[3]!, visibleWidth(MOD[i] ?? "") + 2);
      }
      const ow = snap(wideSplit(), tbars, need, WIN);
      bars = barsOf(ow);
      out.push(junction("┌", "┐", [], bars));
      for (let i = 0; i < 3; i++) out.push(line(ow, [LG[i] ?? "", RUNC[i]!, MAC[i]!, MOD[i] ?? ""], ["c", "l", "l", "l"]));
    } else {
      const one = splitColumns(WIN, [1]);
      out.push(junction("┌", "┐", [], []));
      for (const l of LG) out.push(line(one, [l], ["c"]));
      const need = [0, 0];
      for (let i = 0; i < 3; i++) {
        need[0] = Math.max(need[0]!, visibleWidth(RUNC[i] ?? "") + 2);
        need[1] = Math.max(need[1]!, visibleWidth(MAC[i] ?? "") + 2);
      }
      const ow = snap(splitColumns(WIN, [1, 1]), tbars, need, WIN);
      bars = barsOf(ow);
      out.push(junction("├", "┤", [], bars));
      for (let i = 0; i < 3; i++) out.push(line(ow, [RUNC[i]!, MAC[i]!], ["l", "l"]));
      if (models) {
        out.push(junction("├", "┤", bars, []));
        out.push(line(one, [kvl("models", `${c.mute}${mprefix ? `${mprefix}: ` : ""}${models}${c.off}`)], ["l"]));
        bars = [];
      }
    }
    const one = splitColumns(WIN, [1]);
    // The run settings, one full-width row under the run band.
    if (settingsRows.length) {
      out.push(junction("├", "┤", bars, []));
      for (const part of settingsRows) out.push(line(one, [part], ["l"]));
      bars = [];
    }
    // An unreadable queue is not an empty one: say so, under the run band.
    if (snapshot.queue.error) {
      out.push(junction("├", "┤", bars, []));
      out.push(line(one, [`${c.mute}queue: could not read - ${snapshot.queue.error}${c.off}`], ["l"]));
      bars = [];
    }
    // The table's headings, under a light rule: their bold text sets them apart.
    out.push(junction("├", "┤", bars, tbars));
    const heads = ["TICKET", "STATE", "TIME", "COMMITS"];
    if (wide === 2) heads[4] = "CPU/MEM";
    if (wide >= 1) heads[wide + 3] = "TOKENS";
    heads[TW.length - 1] = "ACTIVITY";
    out.push(line(TW, heads.map((h) => `${c.bold}${c.head}${h}${c.off}`), TAL));
    out.push(junction("├", "┤", tbars, tbars));
    return out;
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
  NOTE.push(`${c.gry}ready = gates green, waits for the landing worker${c.off}`, `${c.gry}time = in state; once finished, start to end${c.off}`, `${c.gry}red time = past twice the usual${c.off}`);
  if (wide >= 1) NOTE.push(`${c.gry}tokens = in/out, cache included${c.off}`);
  if (wide === 2) NOTE.push(`${c.gry}CPU in cores of ${snapshot.cpus}${c.off}`);
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

  let head = header(3);
  // A short pane: the logo folds to one row, so the table keeps some rows.
  if (!showAll && rows - head.length - (footer.length + 1) - 1 < 5) head = header(1);

  // The table body.
  const body: string[] = [];
  const sep = junction("├", "┤", tbars, tbars);
  let up = tbars;
  let footHidden = "";
  let laterLine = "";
  let shown = table.rows;
  if (!showAll && table.later.ids.length > 0) {
    // The collapsing view draws no row for a ticket outside the live run: one line at the foot counts them.
    shown = table.rows.filter((r) => r.state !== "later");
    laterLine = `${table.later.ids.length} for a later run (${idRange(table.later.ids)})${table.later.blocked > 0 ? `, ${table.later.blocked} blocked` : ""}`;
  }
  if (shown.length === 0) {
    // A project whose merged tickets' logs were archived has had runs; the run cell says how the last one ended.
    const cells: string[] = [];
    cells[TW.length - 1] = `${c.mute}${snapshot.hasRecord ? "(nothing to show)" : "(no runs yet)"}${c.off}`;
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
