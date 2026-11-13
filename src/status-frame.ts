// What the status view's frame says besides its ticket table, as plain data: the castle, the title line beside it,
// the lanes (GLOSSARY.md) - run, machine, models, settings, plan - and the legend with its notes. Pure: no process,
// no file, no clock but the one given. No escape code and no layout: every piece of text is a segment
// (`{ text, tone, bold? }`) whose tone is a name of the view's palette (`palette` in src/status-render.ts),
// so `renderFrame` lays the facts out and colours them, and `sandcastle status --json --frame` hands the same facts
// to a view that is not a terminal (an app mod): the two cannot disagree on a word or a colour.

import { HINT_TEXT } from "./click-hint.ts";
import { visibleWidth } from "./status-grid.ts";
import { ago, duration, type Table } from "./status-rows.ts";
import { runEnds, shownId, type Snapshot, type SourceName } from "./status-snapshot.ts";
import { USAGE_AMBER, USAGE_RED, USAGE_STALE_SECONDS } from "./usage.ts";

/** A name of the view's palette, or `plain` for text the view draws in the terminal's own colour. */
export type FrameTone = "plain" | "rule" | "mute" | "head" | "accent" | "wht" | "grn" | "ylw" | "cyn" | "blu" | "gry" | "hot" | "moon" | "dusk" | "night" | "deep" | "star";

/** A piece of text in one colour, bold or not. */
export type Segment = { text: string; tone: FrameTone; bold?: true };
/** One line of a lane, the castle or the title: its segments, left to right. Empty when the line is blank. */
export type FrameRow = Segment[];

export type FrameLane = {
  name: "RUN" | "MACHINE" | "MODELS" | "SETTINGS" | "PLAN";
  /** The name as the view draws it in the lane's top rule. */
  title: Segment;
  rows: FrameRow[];
};

export type LegendGroup = {
  /** The group as `ticketRows` counts it: a key of `Table.counts` ("ready" for what the legend words "ready to land"). */
  name: string;
  count: number;
  segments: FrameRow;
};

export type LegendNote = {
  /** The table column the note explains, when it explains one: a view that does not show the column drops the note. */
  column?: "TOKENS" | "CPU/MEM";
  segments: FrameRow;
};

export type FrameFacts = {
  /** The castle's three rows (its glyphs and the stars beside them), with no text of the title. */
  logo: FrameRow[];
  title: {
    wordmark: string;
    name: string;
    base: string;
    unpushed: number;
    /** "hh:mm:ss" in the machine's zone. */
    clock: string;
    /** The kit's version without a `v`; absent when it could not be read. */
    version?: string;
    /** The title as it sits beside the castle, one row for each of its rows (the wordmark spaced out). */
    rows: FrameRow[];
    /** The title on one row, for a pane too short for the castle beside it. */
    compact: FrameRow;
  };
  /** The lanes the view draws for this snapshot, in priority order. */
  lanes: FrameLane[];
  legend: { groups: LegendGroup[]; notes: LegendNote[] };
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
const rep = (ch: string, n: number) => ch.repeat(Math.max(n, 0));

/** A segment; none when it holds no text, so a bar with nothing filled leaves no empty piece. */
const seg = (tone: FrameTone, t: string, bold?: true): Segment[] => (t === "" ? [] : [bold ? { text: t, tone, bold } : { text: t, tone }]);
const plain = (t: string) => seg("plain", t);
const DOT: Segment[] = seg("rule", " · ");
/** Rows joined by `sep`, the empty ones left out. */
const joined = (rows: FrameRow[], sep: FrameRow = DOT): FrameRow => rows.filter((r) => r.length > 0).flatMap((r, i) => (i === 0 ? r : [...sep, ...r]));
const widthOf = (row: FrameRow) => visibleWidth(row.map((s) => s.text).join(""));

/** A cache share under this is amber in the table, and the TOKENS note says so. */
export const CACHE_AMBER = 70;

/** The frame's facts for `snapshot` and its `table` at `now` (epoch seconds, the snapshot's own in the view). */
export const frameFacts = (snapshot: Snapshot, table: Table, now: number): FrameFacts => {
  const { record, live } = snapshot;
  // A source that has not answered yet (the live view's first paint) draws as empty, and says so where empty would mislead.
  const loading = (source: SourceName) => snapshot.sources?.[source] === "loading";

  const clock = hhmmss(now);
  const unpushed = snapshot.unpushed > 0 ? [...plain(" "), ...seg("hot", `↑${snapshot.unpushed} unpushed`)] : [];
  // The kit's version after the clock, divided as the clock is from the base, in the muted colour so the clock stays the accent.
  const ver = snapshot.version ? [...plain("  "), ...seg("rule", "·"), ...plain("  "), ...seg("mute", `v${snapshot.version}`)] : [];
  const baseRow = [...seg("mute", "base"), ...plain(" "), ...seg("accent", snapshot.base), ...unpushed, ...plain("  "), ...seg("rule", "·"), ...plain("  "), ...seg("accent", clock), ...ver];

  const logo: FrameRow[] = [
    [...plain(" "), ...seg("moon", "▄ ▄ ▄"), ...plain(" "), ...seg("star", "+")],
    [...plain(" "), ...seg("dusk", "█████")],
    [...plain(" "), ...seg("deep", "██▀██"), ...plain(" "), ...seg("star", "·")],
  ];
  const titleRows: FrameRow[] = [
    [...plain("   "), ...seg("moon", "s a n d c a s t l e", true), ...plain(" "), ...seg("night", "- k i t"), ...plain("  "), ...seg("star", "·   +   ·")],
    [...plain("     "), ...seg("head", snapshot.name)],
    [...plain("   "), ...baseRow],
  ];
  const compact: FrameRow = [...seg("moon", "sandcastle-kit", true), ...plain("  "), ...seg("head", snapshot.name), ...plain("  "), ...baseRow];

  // The settings a lane draws from: a live run's, else the next run's, else the last run's.
  const s = snapshot.settings?.settings;
  const mark = snapshot.settings?.from;
  const cross = s ? (s.crossReview === true ? "on" : s.crossReview === false ? "off" : "") : "";

  // A paused run: `PAUSED since 15:40`, and the tickets that still finish a pass or a landing. A run that paused
  // itself for its plan's usage says what it waits for and when it resumes instead: `PAUSED - weekly usage 95%`.
  const pausedRows = (p: NonNullable<typeof record.paused>, began: string): [FrameRow, FrameRow[]] => {
    const since = text(p.since ?? 0);
    const at = digits(since) ? (since.length >= 13 ? Math.floor(Number(since) / 1000) : Number(since)) : utcEpoch(since);
    const finishing = Array.isArray(p.finishing) ? p.finishing.map((id) => [String(id), text(snapshot.tickets[String(id)]?.state ?? (record.tickets?.[String(id)] as { state?: unknown } | undefined)?.state)] as const) : [];
    const list = finishing
      .map(([id, st]) => {
        const word = st === "implement" ? "impl" : st === "cross-review" ? "codex" : st === "ready" ? "landing" : st;
        return `${shownId(id)}${word ? ` ${word}` : ""}`;
      })
      .join(", ");
    const rest = list ? [...seg("mute", "finishing"), ...plain(" "), ...seg("head", list)] : began ? seg("mute", `started ${began}`) : [];
    const usage = p.cause === "usage" && (p.window === "fiveHour" || p.window === "week") && typeof p.percent === "number" && typeof p.resumesAt === "number";
    if (usage) {
      const percent = Math.max(Math.min(Math.floor(p.percent!), 100), 0);
      let what = p.window === "fiveHour" ? "5-hour" : "weekly";
      if (p.provider === "codex") what = `Codex ${what}`;
      return [[...seg("ylw", "● PAUSED", true), ...plain(" "), ...seg("mute", `- ${what} usage ${percent}%`)], [seg("mute", `resumes ${weekdayWhen(Math.floor(p.resumesAt!), now)}`), rest]];
    }
    return [[...seg("ylw", "● PAUSED", true), ...plain(" "), ...seg("mute", `since ${when(at, now)}`)], [rest]];
  };

  // RUN: the state and when the run started, its turn (and the estimated end), its tokens.
  const runLane = (): FrameRow[] => {
    // An API key the sandboxes spend: never silent, so red, in words, beside the tokens it bills - the first lane,
    // so it is shown at any width; the next run's too, before any run is recorded.
    const api = s?.apiKey === true ? seg("hot", "● API credits") : [];
    if (loading("record")) return [[...seg("gry", "○"), ...plain(" "), ...seg("mute", "loading…")], [], api];
    if (!snapshot.hasRecord) return [[...seg("gry", "○"), ...plain(" "), ...seg("mute", "no run recorded yet")], [], api];
    const t0 = utcEpoch(text(record.startedAt));
    const started = when(t0, now);
    // A record with no start time says nothing of when the run started, rather than 1 January 1970.
    const startedAt = (word: string): FrameRow => (t0 ? [...DOT, ...seg("mute", `${word} ${started}`)] : []);
    const stage = text(record.stage) === "running" ? "" : text(record.stage);
    const dry = record.dryRun ? "dry run" : "";
    const finished = text(record.finishedAt);
    const p = record.paused && typeof record.paused === "object" ? record.paused : undefined;
    const turnCap = s && digits(text(s.cap)) ? text(s.cap) : "";
    const turn = s && digits(text(s.turn)) ? [...seg("mute", "turn"), ...plain(" "), ...seg("head", `${text(s.turn)}${turnCap ? `/${turnCap}` : ""}`)] : [];
    let first: FrameRow;
    let second: FrameRow[] = [];
    if (finished) first = [...seg("gry", "○"), ...plain(" "), ...seg("mute", `ended (exit ${text(record.exitCode)})`), ...startedAt("started")];
    else if (live && typeof record.stopped === "string" && record.stopped !== "") {
      // The guard stopped the landing: what is in flight still finishes, nothing more lands - and a stop ends a
      // pause, so the lane never reads PAUSED for a run that cannot resume.
      first = [...seg("hot", "●"), ...plain(" "), ...seg("hot", "STOPPED", true), ...plain(" "), ...seg("mute", "landing"), ...(t0 ? [...DOT, ...seg("mute", duration(now - t0))] : []), ...startedAt("since")];
      second = [seg("mute", "lands nothing more")];
    } else if (live && p) [first, second] = pausedRows(p, t0 ? started : "");
    else if (live) {
      // The stage says what a run is doing before its first sandbox exists, and after its last: "landing 6/25".
      first = [...seg("ylw", "● running"), ...(dry ? [...plain(" "), ...seg("accent", dry)] : []), ...(t0 ? [...DOT, ...seg("mute", duration(now - t0))] : []), ...(stage ? [...DOT, ...seg("accent", stage)] : []), ...startedAt("since")];
      const ends = runEnds(record, snapshot.tickets, now);
      if (ends !== undefined) second = [[...seg("mute", "ends"), ...plain(" "), ...seg("accent", `~${hhmm(ends)}`)]];
    } else first = [...seg("hot", "● killed"), ...DOT, ...seg("mute", "no clean exit"), ...startedAt("started")];
    const tokens = text(record.tokens);
    return [first, joined([turn, ...second]), [...seg("mute", "tokens"), ...plain(" "), ...(tokens ? plain(tokens) : seg("gry", "-")), ...(api.length ? [...DOT, ...api] : [])]];
  };

  // MACHINE: the pool's slots, and what this run wants of it or the gates queue.
  const kvl = (k: string, v: FrameRow): FrameRow => [...seg("mute", k.padEnd(10)), ...v];
  const gauge = (used: number, limit: string): FrameRow => {
    let g: FrameRow = [];
    if (digits(limit) && Number(limit) <= 12) g = [...seg("ylw", rep("█", used)), ...seg("rule", rep("░", Number(limit) - used)), ...plain(" ")];
    return [...g, ...seg("head", `${used}/${limit}`)];
  };
  const gateWait = live ? Object.values(snapshot.tickets).filter((t) => t.state === "gates" && typeof t.note === "string" && t.note.startsWith("waiting for")).length : 0;
  const MAC: FrameRow[] = [kvl("sandboxes", [...gauge(snapshot.pool.sandboxes.used, snapshot.pool.sandboxes.limit), ...(snapshot.pool.sandboxes.outside > 0 ? [...plain(" "), ...seg("hot", `+${snapshot.pool.sandboxes.outside} for gates`)] : [])]), [], []];
  const demand = text(record.demand);
  const share = text(record.share);
  const cap = text(record.cap);
  if (live && digits(demand) && digits(share)) {
    // This run's demand and share take the third row, so the gates queue moves onto the gates row.
    MAC[1] = kvl("gates", [...gauge(snapshot.pool.gates.used, snapshot.pool.gates.limit), ...(gateWait > 0 ? [...plain(" "), ...seg("hot", `· ${gateWait} waiting`)] : [])]);
    MAC[2] = kvl("this run", [...seg("head", `wants ${demand}`), ...seg("gry", " · share "), ...seg("head", share), ...(digits(cap) ? [...seg("gry", " · cap "), ...seg("head", cap)] : [])]);
  } else {
    MAC[1] = kvl("gates", gauge(snapshot.pool.gates.used, snapshot.pool.gates.limit));
    MAC[2] = gateWait > 0 ? kvl("waiting", seg("hot", `${gateWait} for a gates slot`)) : kvl("waiting", seg("gry", "none"));
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
  const kv6 = (k: string, v: FrameRow): FrameRow => [...seg("mute", k.padEnd(6)), ...plain(" "), ...v];
  const modelItems = models
    ? models.split(" · ").map((item) => {
        const space = item.indexOf(" ");
        const label = space < 0 ? item : item.slice(0, space);
        const value = space < 0 ? "" : item.slice(space + 1).replace(/(^|[\s,])claude-/g, "$1");
        return kv6(label === "implement" ? "impl" : label, seg("head", value));
      })
    : [];
  const repair = s ? text(s.repair) : "";
  const MOD: FrameRow[] = [
    modelItems[0] ? [...modelItems[0], ...(mprefix ? [...plain(" "), ...seg("gry", `(${mprefix})`)] : [])] : [],
    joined(modelItems.slice(1)),
    // Repair off is greyed, with the ○ that says so without colour.
    digits(repair) ? (Number(repair) === 0 ? seg("gry", "○ repair") : kv6("repair", seg("head", repair))) : [],
  ];

  // SETTINGS: autonomy, concurrency, cross-review and the usage guard - the turn is in RUN, repair in MODELS.
  const SET: FrameRow[] = [[], [], []];
  if (s) {
    // The keys the clone's untracked local file set; a record whose `local` is not a list of strings marks nothing.
    const localKeys: string[] = Array.isArray(s.local) && s.local.every((k: unknown) => typeof k === "string") ? s.local : [];
    const localMark = (key: string): FrameRow => (localKeys.includes(key) ? [...plain(" "), ...seg("gry", "local")] : []);
    const lvl = text(s.autonomy);
    if (["0", "1", "2", "3", "drain"].includes(lvl)) SET[0] = [...seg("mute", "autonomy"), ...plain(" "), ...seg("accent", `[${lvl}]`, true), ...localMark("autonomy")];
    // Concurrency as the run takes it after the machine-wide cap; what it asked for only when that differs.
    const conc = text(s.concurrency);
    if (digits(conc)) {
      const asked = text(s.asked);
      SET[1] = [...seg("mute", "concurrency"), ...plain(" "), ...seg("head", conc), ...(digits(asked) && Number(asked) !== Number(conc) ? [...plain(" "), ...seg("gry", `(asked ${asked})`)] : []), ...localMark("concurrency")];
    }
    const guards: FrameRow[] = [];
    // The record is a file in a repository: a model or effort that is not plain text is left out of the terminal.
    if (cross === "on") {
      const model = /^[A-Za-z0-9._:/-]+$/.test(text(s.crossReviewModel)) ? text(s.crossReviewModel) : "";
      const effort = ["low", "medium", "high", "xhigh"].includes(text(s.crossReviewEffort)) ? text(s.crossReviewEffort) : "";
      guards.push([...seg("accent", "●"), ...plain(" "), ...seg("mute", "cross-review"), ...(model ? [...plain(" "), ...seg("head", `${model}${effort ? ` ${effort}` : ""}`)] : [])]);
    } else if (cross === "off") guards.push(seg("gry", "○ cross-review"));
    // The usage guard: a lost reading is a fact beside the setting, in the warning colour.
    const stop = digits(text(s.usageStop)) ? text(s.usageStop) : "";
    const guard = s.usageGuard === undefined || s.usageGuard === null ? "" : typeof s.usageGuard === "string" ? s.usageGuard : JSON.stringify(s.usageGuard);
    if (guard === "true") {
      if (text(s.usageReading) === "unavailable") guards.push(seg("ylw", `● usage-guard${stop ? ` ${stop}%` : ""} (no reading - not guarding)`));
      else guards.push([...seg("grn", "●"), ...plain(" "), ...seg("mute", "usage-guard"), ...(stop ? [...plain(" "), ...seg("head", `${stop}%`)] : [])]);
    } else if (guard === "false") guards.push(seg("gry", "○ usage-guard"));
    if (digits(text(s.usagePause))) guards.push([...seg("grn", "●"), ...plain(" "), ...seg("mute", "usage-pause"), ...plain(" "), ...seg("head", `${text(s.usagePause)}%`), ...localMark("usagePause")]);
    SET[2] = joined(guards);
    // The next run's settings are not the ended run's: "next run:" leads the lane, "(last run)" ends it.
    const firstRow = SET.findIndex((r) => r.length > 0);
    if (firstRow >= 0 && mark === "next run") SET[firstRow] = [...seg("gry", "next run:"), ...plain(" "), ...SET[firstRow]!];
    const lastRow = SET.findLastIndex((r) => r.length > 0);
    if (lastRow >= 0 && mark === "last run") SET[lastRow] = [...SET[lastRow]!, ...plain(" "), ...seg("gry", "(last run)")];
  }

  // PLAN: a live run's plan usage, each window a provider's reading carries; left out without one.
  const PLAN: FrameRow[] = [];
  if (live) {
    const settingsGroup = record.settings && typeof record.settings === "object" ? record.settings : {};
    const entries = (Array.isArray(record.usage) ? record.usage : record.usage && typeof record.usage === "object" ? [record.usage] : []).filter(
      (u) => u && typeof u === "object" && ((u.provider === "claude" && settingsGroup.apiKey !== true) || (u.provider === "codex" && settingsGroup.crossReview !== false)),
    );
    const readings: FrameRow[][] = [];
    for (const u of entries) {
      const num = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.floor(v) : undefined);
      const p5 = num(u.windows?.fiveHour?.percent);
      const r5 = num(u.windows?.fiveHour?.resetsAt);
      const pw = num(u.windows?.week?.percent);
      const rw = num(u.windows?.week?.resetsAt);
      const at = num(u.at);
      // A reading may carry one window (Claude Code writes the weekly one alone): the other is a blank cell as wide as it would be.
      const five = p5 !== undefined && r5 !== undefined ? { percent: p5, resetsAt: r5 } : undefined;
      const week = pw !== undefined && rw !== undefined ? { percent: pw, resetsAt: rw } : undefined;
      if ((!five && !week) || at === undefined) continue;
      const age = Math.max(now - at, 0);
      // A stale reading is greyed, its age beside it.
      const grey = age > USAGE_STALE_SECONDS;
      const window = (label: string, percent: number, resets: string): FrameRow => {
        const pct = Math.min(percent, 100);
        const tone: FrameTone = grey ? "gry" : pct >= USAGE_RED ? "hot" : pct >= USAGE_AMBER ? "ylw" : "head";
        let filled = Math.floor((pct + 10) / 20);
        if (pct > 0 && filled === 0) filled = 1;
        return [...seg("mute", label.padEnd(4)), ...plain(" "), ...seg(tone, rep("▓", filled)), ...seg("gry", rep("░", 5 - filled)), ...plain(" "), ...seg(tone, `${String(pct).padStart(3)}%`), ...plain(" "), ...seg("mute", `· resets ${resets}`)];
      };
      const weekResets = (w: number) => `${WEEKDAYS[local(w).getDay()]} ${hhmm(w)}`;
      // The blank is measured from the cell the renderer draws, never counted by hand.
      const blank = (cell: FrameRow) => plain(rep(" ", widthOf(cell)));
      const fiveCell = five ? window("5h", five.percent, hhmm(five.resetsAt)) : blank(window("5h", 0, hhmm(0)));
      const weekCell = week ? window("week", week.percent, weekResets(week.resetsAt)) : blank(window("week", 0, weekResets(0)));
      readings.push([[...seg("mute", String(u.provider).padEnd(6)), ...plain(" "), ...fiveCell], weekCell, seg("mute", `(${ago(age)} ago)`)]);
    }
    // One provider takes a row for each window; two take a row each.
    if (readings.length === 1) PLAN.push(readings[0]![0]!, [...plain(rep(" ", 7)), ...readings[0]![1]!], [...plain(rep(" ", 7)), ...readings[0]![2]!]);
    else for (const r of readings) PLAN.push([...r[0]!, ...DOT, ...r[1]!, ...DOT, ...r[2]!]);
  }

  // The lanes, in priority order: the first that do not fit fold into the summary line.
  const lane = (name: FrameLane["name"], rows: FrameRow[]): FrameLane => ({ name, title: { text: name, tone: "head", bold: true }, rows });
  const lanes: FrameLane[] = [lane("RUN", runLane()), lane("MACHINE", MAC)];
  if (MOD.some((r) => r.length > 0)) lanes.push(lane("MODELS", MOD));
  if (SET.some((r) => r.length > 0)) lanes.push(lane("SETTINGS", SET));
  if (PLAN.length) lanes.push(lane("PLAN", PLAN));

  // The legend, each group with its count, then the notes.
  const n = table.counts;
  const group = (name: string, count: number, tone: FrameTone, label: string): LegendGroup => ({ name, count, segments: [...seg(tone, `${label} `), ...seg(tone, String(count), true)] });
  const groups: LegendGroup[] = [
    group("working", n.working, "ylw", "● working"),
    group("needs you", n["needs you"], "hot", "! needs you"),
    group("ready", n.ready, "cyn", "> ready to land"),
    group("queued", n.queued, "blu", "○ queued"),
    group("blocked", n.blocked, "blu", "~ blocked"),
    group("merged", n.merged, "grn", "+ merged"),
  ];
  // Tickets outside the live run, a group of their own: queued and blocked count the run's alone.
  if (n.later > 0) groups.push(group("later", n.later, "gry", "… later"));
  groups.push(group("left over", n["left over"], "gry", "- left over"), group("idle", n.idle, "gry", "· idle"));
  const notes: LegendNote[] = [];
  const note = (t: string, column?: LegendNote["column"]) => notes.push({ ...(column ? { column } : {}), segments: seg("gry", t) });
  // The view reads git, not the agents' notes: the closing summary counts a merged ticket left open under "needs you".
  if (table.partly > 0) {
    note(`${table.partly} merged, partly done (ticket open)`);
    note("the closing summary counts it under needs you");
  }
  note("ready = gates green, waits for the landing worker");
  note("time = in state, ~ what it usually has left; once finished, start to end");
  note("red time = past twice the usual");
  // Both columns' notes are always here: the terminal drops the one whose column its pane is too narrow to show.
  note(`tokens = in, % of it from cache (amber under ${CACHE_AMBER}%), out`, "TOKENS");
  note(`CPU in cores of ${snapshot.cpus}`, "CPU/MEM");
  // Each sandbox terminal by its herdr-core address: what `hc` and the apps take to find it.
  if (snapshot.terminals?.length) note(`terminals: ${snapshot.terminals.join(", ")}`);
  if (snapshot.links) note(HINT_TEXT[snapshot.clickMod === "ctrl" || snapshot.clickMod === "cmd" ? snapshot.clickMod : "fallback"]);

  return {
    logo,
    title: {
      wordmark: "sandcastle-kit",
      name: snapshot.name,
      base: snapshot.base,
      unpushed: snapshot.unpushed,
      clock,
      ...(snapshot.version ? { version: snapshot.version } : {}),
      rows: titleRows,
      compact,
    },
    lanes,
    legend: { groups, notes },
  };
};
