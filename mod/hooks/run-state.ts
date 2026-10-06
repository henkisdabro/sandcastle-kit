// What the mod says about a run record (.sandcastle/logs/run.json). Pure: nothing here
// touches Claude Code, so the kit's own tests import this file and hold it to the status
// view's vocabulary (status.sh, `style_of`). The record's types, the ticket states and the
// tables from state to group and word live in run-record.ts.

import { GROUPS, type Group, isTicketState, type RunRecord, sessionId, WORDS } from "./run-record.ts";

/** A ticket as read from a file that may be a stranger's: its state is any short text until `isTicketState` says otherwise. */
export type Ticket = { state?: string; note?: string; title?: string; order?: number };

/** The run record as the mod reads it: the fields it shows, and tickets whose state is not yet trusted. */
export type Run = Pick<RunRecord, "orchestrator" | "pid" | "session" | "startedAt" | "finishedAt" | "exitCode" | "stage" | "tokens"> & { tickets?: Record<string, Ticket> };

// The status view's sand palette, as hex: a mod's Text takes no 256-colour index. Dry sand at
// the castle's top, wet sand at its base.
export const SAND = { top: "#e8d6b4", mid: "#cdb894", base: "#705c42", name: "#cdb894", stage: "#c0a478", muted: "#927c5e" };

/** The castle's three rows, each five cells wide. */
export type Castle = { top: string; mid: string; base: string };

// The status view's three-row castle: the battlements stand a row above the text beside it.
// A castle cut to one row (a bare slab) reads as no castle at all, so the view's one-row fold
// draws none, only the wordmark.
export const CASTLE: Castle = { top: "▄ ▄ ▄", mid: "█████", base: "██▀██" };

// While a ticket is in work the castle builds from level sand, half a row at a time, and holds
// complete before it starts again: a loop the eye follows as work going on, where a long hold
// read as the run standing still. Every frame is a whole number of one 500 ms beat and the loop
// is twelve of them (three bars of four), so the build keeps time and the restart lands on the
// bar; the hold is never shorter than the build, so the finished castle is what the eye mostly sees. Every row of every frame is five cells, so the
// text beside it never moves, and the band's height never changes.
const AIR = "     ";
export const CASTLE_FRAMES: (Castle & { ms: number })[] = [
  { top: AIR, mid: AIR, base: "▁▁▁▁▁", ms: 500 },
  { top: AIR, mid: AIR, base: "▄▄▄▄▄", ms: 500 },
  { top: AIR, mid: AIR, base: CASTLE.base, ms: 500 },
  { top: AIR, mid: "▄▄▄▄▄", base: CASTLE.base, ms: 500 },
  { top: AIR, mid: CASTLE.mid, base: CASTLE.base, ms: 500 },
  { ...CASTLE, ms: 3500 },
];
/** The held frame: the castle as the status view draws it. */
export const HELD = CASTLE_FRAMES.length - 1;

/** The status view's legend: its order, glyphs, words and colours. */
export const LEGEND: { group: Group; glyph: string; label: string; colour: string }[] = [
  { group: "working", glyph: "●", label: "working", colour: "#ffd75f" },
  { group: "needs you", glyph: "!", label: "needs you", colour: "#ff5f5f" },
  { group: "ready", glyph: ">", label: "ready to land", colour: "#5fd7d7" },
  { group: "queued", glyph: "○", label: "queued", colour: "#87afff" },
  { group: "blocked", glyph: "~", label: "blocked", colour: "#87afff" },
  { group: "merged", glyph: "+", label: "merged", colour: "#5fd75f" },
];

// A state that is no ticket state (`constructor` included) is in no group and has no word of its own.
const group = (t: Ticket): Group => (isTicketState(t.state) ? GROUPS[t.state] : "other");

const word = (state: string | undefined) => (isTicketState(state) ? WORDS[state] : undefined) ?? state ?? "unknown";

// The record is a file in a repository, which may be a stranger's: nothing in it is trusted to
// be what src/run.ts writes. Text is cut to one short line with nothing in it that draws no
// glyph - control, format (direction marks, tag characters), line separators, variation
// selectors, private-use and half a surrogate pair - so it cannot pose as a line of its own in
// what Claude reads, carry words a person cannot see, or redraw the terminal. Cut by code
// point: a cut through an emoji would leave half of one. A number is a whole number or absent.
const text = (v: unknown, max: number) =>
  typeof v === "string"
    ? Array.from(v.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Variation_Selector}]+/gu, " ").trim())
        .slice(0, max)
        .join("") || undefined
    : undefined;
const whole = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const MAX_TICKETS = 200;

export { RUN_COMMAND } from "./run-live.ts";

// A ticket as the kit writes it (src/tracker.ts, `refOf`): `#12` for a number, the id itself
// for a ticket file.
const ref = (id: string) => (/^\d+$/.test(id) ? `#${id}` : id);

/** A half-written or foreign file reads as no record. */
export const parse = (raw: string): Run | undefined => {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!r || typeof r !== "object") return undefined;
  const tickets = r.tickets && typeof r.tickets === "object" ? Object.entries(r.tickets as Record<string, Record<string, unknown> | null>) : [];
  return {
    orchestrator: text(r.orchestrator, 40),
    // 0 is no process.
    pid: whole(r.pid) || undefined,
    session: sessionId(r.session),
    startedAt: text(r.startedAt, 40),
    finishedAt: text(r.finishedAt, 40),
    exitCode: whole(r.exitCode),
    stage: text(r.stage, 40),
    tokens: text(r.tokens, 40),
    tickets: Object.fromEntries(
      // A ticket file's id is a whole slug: cut short, two tickets of one feature would share a key.
      tickets.slice(0, MAX_TICKETS).map(([id, t]) => [text(id, 100) ?? "?", { state: text(t?.state, 24), note: text(t?.note, 100), title: text(t?.title, 100), order: whole(t?.order) }]),
    ),
  };
};

const tickets = (run: Run) => Object.entries(run.tickets ?? {});

/** The tickets a person has to act on: `#105 conflict`. */
export const needing = (run: Run): string[] =>
  tickets(run)
    .filter(([, t]) => group(t) === "needs you")
    .map(([id, t]) => `${ref(id)} ${word(t.state)}`);

/** What the band above the prompt draws from: plain data, so it can live in `$.state`. */
export type Summary = { name: string; stage: string; counts: number[]; tokens: string };

/** `counts` runs parallel to LEGEND. */
export const summarise = (run: Run): Summary => ({
  name: run.orchestrator ?? "",
  // One process can hold several turns: a finished record with a live process is between two.
  stage: run.finishedAt ? "turn finished" : run.stage && run.stage !== "running" ? run.stage : "",
  counts: LEGEND.map((g) => tickets(run).filter(([, t]) => group(t) === g.group).length),
  tokens: run.tokens ?? "",
});

export type Segment = { text: string; colour: string; bold?: true; count?: number };

/** Whether the run has a ticket in work: the castle builds only then. */
export const building = (s: Summary): boolean => (s.counts[LEGEND.findIndex((g) => g.group === "working")] ?? 0) > 0;

/**
 * The band's three rows, each cut to the width it is drawn in: the castle's battlements alone,
 * its walls with the run (name, stage, tokens), and its base with the legend - in words while
 * they fit, then the glyphs alone. A row that wraps would push the prompt down every time a
 * count gains a digit.
 */
export const band = (s: Summary, columns: number, castle: Castle = CASTLE): Segment[][] => {
  // Two columns between segments, one between a segment's text and its count.
  const width = (row: Segment[]) => row.reduce((n, seg) => n + seg.text.length + (seg.count === undefined ? 0 : 1 + String(seg.count).length), 2 * (row.length - 1));
  const fit = (tries: Segment[][]) => tries.find((row) => width(row) <= columns) ?? tries.at(-1) ?? [];
  const run = (name: boolean, tokens: boolean): Segment[] =>
    [
      { text: castle.mid, colour: SAND.mid },
      { text: "sandcastle", colour: SAND.top, bold: true as const },
      { text: name ? s.name : "", colour: SAND.name },
      { text: s.stage, colour: SAND.stage },
      { text: tokens ? s.tokens : "", colour: SAND.muted },
    ].filter((seg) => seg.text);
  const legend = (words: boolean): Segment[] => [
    { text: castle.base, colour: SAND.base },
    ...LEGEND.map((g, i) => ({ text: words ? `${g.glyph} ${g.label}` : g.glyph, count: s.counts[i] ?? 0, colour: g.colour })).filter((seg) => seg.count),
  ];
  return [[{ text: castle.top, colour: SAND.top }], fit([run(true, true), run(true, false), run(false, false)]), fit([legend(true), legend(false)])];
};

/** The same summary as one line of text, for `/sandcastle-status`. A run that is over has no stage. */
export const line = (run: Run, live: boolean): string => {
  const s = summarise(run);
  return [live && s.stage, ...LEGEND.flatMap((g, i) => (s.counts[i] ? [`${g.glyph} ${g.label} ${s.counts[i]}`] : [])), s.tokens].filter(Boolean).join(" · ");
};

/** One line per ticket, in the status view's order: working first, then what needs a person. */
export const rows = (run: Run): string[] => {
  const place = (t: Ticket) => LEGEND.findIndex((g) => g.group === group(t));
  const rank = (t: Ticket) => (place(t) < 0 ? LEGEND.length : place(t));
  return tickets(run)
    .sort(([, a], [, b]) => rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0))
    .map(([id, t]) => `${LEGEND[place(t)]?.glyph ?? "·"} ${ref(id)} ${word(t.state)}${t.note ? ` (${t.note})` : ""}${t.title ? ` - ${t.title}` : ""}`);
};

/**
 * Lists the machine-wide live-runs registry (src/live-runs.ts): its directory is
 * `$XDG_CACHE_HOME`, or `~/.cache` when that is unset or empty, on Linux and macOS alike. Prints
 * the session root's resolved path (`pwd -P`: `/tmp` is `/private/tmp` on macOS, and one project
 * must not read as two), then one resolved root per registered run, a line each. POSIX sh, and
 * `cat`, `cd` and `pwd -P` only: BSD and GNU alike. A root that is gone prints nothing.
 * `$1` is the session's root.
 */
export const REGISTRY_SCRIPT = [
  'dir="${XDG_CACHE_HOME:-$HOME/.cache}/sandcastle-kit/runs"',
  '(cd -- "$1" 2>/dev/null && pwd -P) || echo',
  'for f in "$dir"/*; do',
  '  [ -f "$f" ] || continue',
  '  r=$(cat -- "$f" 2>/dev/null)',
  '  [ -n "$r" ] && (cd -- "$r" 2>/dev/null && pwd -P)',
  "done",
  "exit 0",
].join("\n");

/** The script's output: the session's own root (empty when it could not be resolved) and the registered ones, as resolved strings compared as they are (no case folding). */
export const parseRegistry = (stdout: string): { own: string; roots: string[] } => {
  const [own = "", ...rest] = stdout.split("\n");
  return { own, roots: [...new Set(rest.filter(Boolean))] };
};

/**
 * The registered roots this session may follow: every one but its own, which the watch of the
 * session's root already covers. With no resolved root of its own it follows none - failing closed
 * (a shell that cannot resolve it, BusyBox `ps` and the like) beats watching one run twice.
 */
export const followable = ({ own, roots }: { own: string; roots: string[] }): string[] => (own ? roots.filter((r) => r !== own) : []);

/** Whether `run` is the run of the session with this id. A run with no recorded id (a plain terminal, Codex, OpenCode) has no owner. */
export const startedBy = (run: Run | undefined, session: string): boolean => !!run?.session && run.session === session;
