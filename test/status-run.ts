// How a test starts the status view: the TypeScript view (src/status-view.ts), with the fixture clock preloaded.
// The tests start it directly where a black-box test needs the view and nothing of `status.sh`'s wrapper;
// test/status-wrapper.test.ts holds that `status.sh` hands every call to it.
//
// `statusCommand` is the one place a test names the view's entry. `drawFrame` draws one frame and
// returns it; `startSession` (further down) starts the live view on a terminal and drives it from
// outside, as a person or Herdr would.

import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnSyncOptions, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT, kitArgs } from "./cli-spawn.ts";
import { fixtureEnv, type Fixture } from "./status-fixture.ts";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The TypeScript view's entry. */
export const TS_ENTRY = join(KIT, "src/status-view.ts");
/** The preload that gives the view the fixture clock (`SANDCASTLE_TEST_NOW`), so the view has no test seam. */
const TS_CLOCK = join(KIT, "test/status-clock.ts");

/** The command that starts the view with `args` (its interval, then "all" for every row). */
export const statusCommand = (args: string[]): { command: string; args: string[] } => ({
  command: process.execPath,
  args: [...kitArgs("--import", TS_CLOCK, TS_ENTRY, ...args)],
});

/** `spawnSync` of the view with `args`: what a black-box test calls where it used to name status.sh. */
export function spawnStatus(args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnStatus(args: string[], options: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function spawnStatus(args: string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  const { command, args: viewArgs } = statusCommand(args);
  return spawnSync(command, viewArgs, options);
}

/** The arguments of `script(1)` that run the view with `args` on a pty: util-linux and BSD spell it differently. Give `script` no stdin (`stdio: ["ignore", ...]`): BSD refuses the socket Node passes. */
export const scriptArgs = (args: string[]): string[] => {
  const { command, args: viewArgs } = statusCommand(args);
  return process.platform === "linux" ? ["-qec", [command, ...viewArgs].map(quote).join(" "), "/dev/null"] : ["-q", "/dev/null", command, ...viewArgs];
};

/** A UTF-8 locale for a test's own shell tools (Linux runners often have only C.UTF-8); none found is fine for the view. */
export const utf8Locale = (): string | undefined => {
  try {
    return execFileSync("locale", ["-a"], { encoding: "utf8" }).split("\n").find((l) => /^(c|en_US)\.utf-?8$/i.test(l));
  } catch {
    return undefined;
  }
};

/** The environment of a view drawing `fixture`: the fixture's clock, zone and fakes, no colour, a fixed pane. */
export const viewEnv = (fixture: Fixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const locale = utf8Locale();
  return { ...process.env, ...(locale ? { LC_ALL: locale } : {}), NO_COLOR: "1", ...fixtureEnv(fixture), ...extra };
};

/** Colour codes and OSC 8 link markers out of a frame. */
export const plain = (text: string): string => text.replace(/\u001b\]8;[^\u001b]*\u001b\\/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

export type Drawn = { frame: string; raw: string; status: number | null; stderr: string; result: SpawnSyncReturns<string> };

/** `status 0 all` of `fixture` at `cols` columns: the frame as plain text. */
export const drawFrame = (fixture: Fixture, { cols = 80, rows = 400, env = {} }: { cols?: number; rows?: number; env?: Record<string, string> } = {}): Drawn => {
  const { command, args } = statusCommand(["0", "all"]);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: viewEnv(fixture, { TERM_COLS: String(cols), TERM_ROWS: String(rows), ...env }),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { frame: plain(result.stdout), raw: result.stdout, status: result.status, stderr: result.stderr, result };
};

/**
 * `status 0 all` of `fixture` at each of `widths`, from one reading of its sources (test/status-frames.ts): for a
 * test of the layout, which needs no fresh snapshot a width. The first width is also drawn by the view itself, and
 * the two must be the same frame, so this draws what the view would.
 */
export const drawFrames = (fixture: Fixture, widths: number[], { rows = 400, env = {} }: { rows?: number; env?: Record<string, string> } = {}): Drawn[] => {
  const options = { encoding: "utf8" as const, env: viewEnv(fixture, { TERM_ROWS: String(rows), ...env }), stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[], timeout: 60_000 };
  const result = spawnSync(process.execPath, kitArgs("--import", TS_CLOCK, join(KIT, "test/status-frames.ts"), String(rows), ...widths.map(String)), options);
  if (result.status !== 0) throw new Error(`test/status-frames.ts ended ${result.status}: ${result.stderr}`);
  const drawn = (JSON.parse(result.stdout) as string[]).map((raw): Drawn => ({ frame: plain(raw), raw, status: 0, stderr: "", result }));
  const own = drawFrame(fixture, { cols: widths[0], rows, env });
  if (own.raw !== drawn[0]?.raw) throw new Error(`the view's own frame at ${widths[0]} columns is not the one drawn from one snapshot:\n${own.raw}\n---\n${drawn[0]?.raw}`);
  return drawn;
};

/** The slots the view's machine lane shows in use against the limit (`3/6`), drawn with `env` (`XDG_CACHE_HOME` says whose slots). */
export const machineSlots = (fixture: Fixture, env: Record<string, string> = {}): { sandboxes?: string; gates?: string } => {
  const drawn = drawFrame(fixture, { cols: 200, env });
  if (drawn.status !== 0) throw new Error(`the view ended ${drawn.status}: ${drawn.stderr}`);
  const { run } = readFacts(drawn.raw, fixture.root);
  return { sandboxes: run.sandboxes?.split(" ")[0], gates: run.gates?.split(" ")[0] };
};

/** The facts of `fixture`'s frame at `cols` columns. */
export const factsAt = (fixture: Fixture, cols: number, env: Record<string, string> = {}): Facts => {
  const drawn = drawFrame(fixture, { cols, env });
  if (drawn.status !== 0) throw new Error(`the view ended ${drawn.status}: ${drawn.stderr}`);
  return readFacts(drawn.raw, fixture.root);
};

// ---------------------------------------------------------------------------
// The fact reader.
//
// The facts a `status 0` frame shows, read without the layout: which tickets are shown and each one's
// group, state word, time, commits, CPU/MEM, tokens and note, the links, the run's header cells, the
// settings, the usage row and the group counts. A fact a frame hides is `undefined` (a column that gave
// way in a narrow pane; a header label a wide layout drops), and a text cut with `…` ends in it.
// `compareFacts` leaves both out: an unknown fact agrees with anything, and a cut text agrees with
// any text it is the start of. So one fixture's frames at 80 and 330 columns compare equal.
// ---------------------------------------------------------------------------

/** What each row's glyph stands for: the view's own groups. */
const GROUP_OF_GLYPH: Record<string, string> = {
  "●": "working",
  "!": "needs you",
  ">": "ready to land",
  "○": "queued",
  "~": "blocked",
  "+": "merged",
  "…": "later",
  "-": "left over",
  "·": "idle",
};

export type TicketFacts = {
  /** As the table prints it: `#101`, or a slug. */
  id: string;
  group: string;
  /** The state word, `impl` or `gate red` as the view says it. */
  state: string;
  time?: string;
  /** What the step usually has left (`~4m`), shown beside the time by the TypeScript view only; not compared. */
  left?: string;
  commits?: string;
  cpuMem?: string;
  tokens?: string;
  note: string;
  /** Where the ticket's link points, with the project's path as `$PROJECT`; absent when the row has no link. */
  link?: string;
};

export type Facts = {
  /** The header's name, base branch, clock and unpushed count (`↑2 unpushed`). */
  project: { name?: string; base?: string; clock?: string; unpushed?: string };
  /**
   * The header's run facts, from its labelled cells or its lanes, the gauge bars out: `state`, `started` (a live
   * run's "since"), `ends`, `turn`, `finishing`, `resumes`, `tokens`, `api`, `sandboxes`, `gates`, `this run`,
   * `waiting`, `models` (each item `implement` or `review` and its model, without `claude-`) and `repair`.
   */
  run: Record<string, string>;
  /** The settings' items, the autonomy scale reduced to the level chosen; unknown when a cut summary line hid them. The turn, repair and an API key's spend are `run` facts wherever a layout puts them. */
  settings?: string[];
  usage?: string;
  tickets: TicketFacts[];
  /** The footer's count of each group. */
  counts: Record<string, number>;
  /** Whether the click hint is shown. */
  hint: boolean;
};

const HEADER_LABELS = ["state", "since", "ends", "started", "finished", "finishing", "resumes", "tokens", "sandboxes", "gates", "this run", "waiting", "models", "settings", "usage"];
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const noBars = (s: string) => squash(s.replace(/[░▒▓█▌▏▎▍▋▊▉]+/g, " "));

/** A header's lanes (GLOSSARY.md), by name: each lane's name in the rule above its cells, or in a summary line. */
const LANE = /[┌├┬┼]─ (RUN|MACHINE|MODELS|SETTINGS|PLAN) ─/g;
const SUMMARY = /^(run|machine|models|settings|plan) {2}(.*)$/;
const MACHINE_LABEL = /^(sandboxes|gates|this run|waiting) (.*)$/;
// A run's facts that are items of one line: what a lane's row or a labelled cell says after its label.
const RUN_ITEM = /^(since|started|ends|turn|finishing|resumes|tokens) (.+)$/;
const RUN_MARK = / \((last|next) run\)$/;

/** A line's cells between `│`, each with the column it starts at. */
const cellsOf = (line: string): { x: number; text: string }[] => {
  const cells: { x: number; text: string }[] = [];
  let x = 0;
  for (const part of line.split("│").slice(1, -1)) {
    cells.push({ x: x + 1, text: part });
    x += part.length + 1;
  }
  return cells;
};

/** The facts of a frame as the view drew it (`root` is the project's path, `$PROJECT` in a link). */
export const readFacts = (raw: string, root: string): Facts => {
  const links = new Map<string, string>();
  for (const m of raw.matchAll(/\u001b\]8;;([^\u001b]*)\u001b\\([^\u001b]*)\u001b\]8;;\u001b\\/g)) {
    const path = decodeURIComponent(m[1]!.replace(/^file:\/\//, "")).split(root).join("$PROJECT");
    links.set(squash(m[2]!), path);
  }
  const lines = plain(raw).split("\n");
  const facts: Facts = { project: {}, run: {}, settings: [], tickets: [], counts: {}, hint: /click a ticket for its/.test(raw) };

  const header = lines.findIndex((l) => /TICKET/.test(l) && /ACTIVITY/.test(l));
  if (header < 0) throw new Error(`no ticket table in the frame:\n${lines.join("\n")}`);

  // The header: the logo's lines, then labelled cells or lanes. A cell with a label starts a field; an unlabelled one
  // under it (same column) continues it. A cell under a lane's name is a row of that lane; a summary line holds
  // the lanes that did not fit, `name  row · row`, apart by `│`.
  let current = new Map<number, string>();
  let lanesAt = new Map<number, string>();
  const fields = new Map<string, string>();
  const lanes = new Map<string, string[]>();
  let cut = false;
  const laneRow = (lane: string, row: string) => lanes.set(lane, [...(lanes.get(lane) ?? []), row]);
  for (const line of lines.slice(0, header)) {
    if (!line.startsWith("│")) {
      current = new Map();
      lanesAt = new Map([...line.matchAll(LANE)].map((m) => [m.index + 1, m[1]!]));
      continue;
    }
    const name = line.match(/█████\s+(\S+)/);
    if (name) facts.project.name = name[1];
    const base = line.match(/base (\S+)(?: ↑(\d+) unpushed)?\s+·\s+(\d\d:\d\d:\d\d)/);
    if (base) Object.assign(facts.project, { base: base[1], clock: base[3], ...(base[2] ? { unpushed: `↑${base[2]} unpushed` } : {}) });
    const inner = line.slice(1, -1).trim();
    const summary = inner.match(SUMMARY);
    if (summary && inner.endsWith("…")) cut = true;
    if (summary && (inner.includes(" │ ") || ["run", "machine", "plan"].includes(summary[1]!))) {
      for (const part of inner.split(" │ ")) {
        const m = part.match(SUMMARY);
        if (m) laneRow(m[1]!.toUpperCase(), m[2]!);
      }
      continue;
    }
    for (const { x, text } of cellsOf(line)) {
      const body = text.trim();
      if (lanesAt.has(x)) {
        if (body) laneRow(lanesAt.get(x)!, body);
        continue;
      }
      if (!body || body.startsWith("base ") || (/[▄█]/.test(body) && !HEADER_LABELS.some((l) => body.startsWith(l)))) continue;
      const label = HEADER_LABELS.find((l) => new RegExp(`^${l}(\\s|$)`).test(body));
      if (label) {
        current.set(x, label);
        fields.set(label, body.slice(label.length));
      } else if (current.has(x)) {
        const key = current.get(x)!;
        // The wide layout's models cell has an item a row.
        fields.set(key, `${fields.get(key)}${key === "models" ? " · " : " "}${body}`);
      } else {
        // A wide layout drops the label of the models cell: the one unlabelled cell with text is the models.
        current.set(x, "models");
        fields.set("models", body);
      }
    }
  }

  // The run's facts are items: the labelled cells' values, or the RUN lane's rows, split at ` · `.
  const runItems: string[] = [];
  for (const label of ["state", "since", "ends", "started", "finishing", "resumes", "tokens"]) {
    const value = fields.get(label);
    if (value === undefined) continue;
    const [first, ...rest] = squash(value).split(" · ");
    runItems.push(label === "state" ? first! : `${label} ${first}`, ...rest);
  }
  for (const row of lanes.get("RUN") ?? []) runItems.push(...squash(row).split(" · "));
  for (const row of lanes.get("MACHINE") ?? []) {
    // A summary line's machine items are apart by ` · `, which a value can hold too: an item starts at a label. A
    // summary cut inside a label leaves the item before it whole or not, so that one is cut too.
    let last = "";
    const parts = squash(row).split(" · ");
    parts.forEach((part, i) => {
      const m = part.match(MACHINE_LABEL);
      if (m) fields.set((last = m[1]!), m[2]!);
      else if (!last) return;
      else if (i === parts.length - 1 && part.endsWith("…")) fields.set(last, `${fields.get(last)}…`);
      else fields.set(last, `${fields.get(last)} · ${part}`);
    });
  }
  if (lanes.has("MODELS")) fields.set("models", lanes.get("MODELS")!.join(" · "));
  if (lanes.has("SETTINGS")) fields.set("settings", lanes.get("SETTINGS")!.join(" · "));
  if (lanes.has("PLAN")) fields.set("usage", lanes.get("PLAN")!.join(" "));

  let settings: string[] = [];
  for (const [label, value] of fields) {
    if (label === "settings") {
      settings = noBars(value)
        .replace(/autonomy [\d ]*\[(\w+)\][\w ]*?(?= ·|$)/, "autonomy $1")
        .replace(/autonomy \[(\w*)…$/, "autonomy $1…")
        // A narrow pane wraps the row where an item starts, with no separator: the bullet marks the item.
        .split(/\s+·\s+|\s+(?=[●○] )/)
        .map(squash);
    } else if (label === "usage") {
      // One line or a row for each window, apart by spaces or ` · `: the words in order.
      facts.usage = squash(noBars(value).replace(/\s*·\s*/g, " "));
    } else if (label === "models") {
      // An ended run's models are the last run's, said as a prefix in a narrow pane and as a suffix in a wide one.
      let models = noBars(value);
      const from = models.match(/^(last|next) run: /) ?? models.match(/ \((last|next) run\)/);
      if (from) {
        models = models.replace(/^(last|next) run: /, "").replace(/ \((last|next) run\)/, "");
        facts.run["models from"] = `${from[1]} run`;
      }
      // The repair attempts are the models lane's last row; an `impl` label is `implement`, and an id loses `claude-` there.
      const items: string[] = [];
      for (const item of models.split(" · ")) {
        if (/^(○ )?repair\b/.test(item)) facts.run.repair = item.replace(/^repair /, "");
        else items.push(item.replace(/^impl /, "implement ").replace(/(^|[\s,])claude-/g, "$1"));
      }
      facts.run.models = items.join(" · ");
    } else if (!["state", "since", "ends", "started", "finishing", "resumes", "tokens"].includes(label)) facts.run[label] = noBars(value);
  }
  // A summary line cut before the settings hides them: they are unknown, not none.
  if (cut && !fields.has("settings")) facts.settings = undefined;
  // The turn and the repair attempts are run facts wherever a layout puts them, and so is an API key's spend.
  for (const item of settings) {
    const bare = item.replace(RUN_MARK, "");
    if (bare.startsWith("turn ")) runItems.push(bare);
    else if (/^(○ )?repair\b/.test(bare)) facts.run.repair = bare.replace(/^repair /, "");
    else if (/API credits/.test(item)) runItems.push(item);
    else facts.settings?.push(item);
  }
  const state: string[] = [];
  for (const raw of runItems) {
    const item = squash(raw).replace(/^[●○] /, "");
    const m = item.match(RUN_ITEM);
    // The run's start time, "since" while it is live and "started" once it ended.
    if (m) facts.run[m[1] === "since" ? "started" : m[1]!] = noBars(m[2]!);
    else if (/API credits/.test(item)) facts.run.api = "API credits";
    // A summary line cut inside an item leaves a part that says nothing for certain.
    else if (item && !item.endsWith("…")) state.push(item);
  }
  if (state.length) {
    // A paused run's state can carry what it finishes and when it resumes, which another layout puts apart.
    let value = state.join(" · ");
    const finishing = value.match(/ - finishing (.+)$/);
    if (finishing) [value, facts.run.finishing] = [value.slice(0, finishing.index), finishing[1]!];
    const resumes = value.match(/, resumes (.+)$/);
    if (resumes) [value, facts.run.resumes] = [value.slice(0, resumes.index), resumes[1]!];
    facts.run.state = value;
  }

  // The table.
  const columns = cellsOf(lines[header]!).map((c) => c.text.trim());
  const col = (name: string) => columns.indexOf(name);
  let end = header + 1;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    if (line.startsWith("├") && line.includes("┴")) break;
    if (!line.startsWith("│")) continue;
    const cells = cellsOf(line).map((c) => c.text.trim());
    if (cells.length !== columns.length || !cells[0]) continue;
    const state = cells[col("STATE")]!.match(/^(\S+) (.+)$/);
    const at = (name: string) => (col(name) < 0 ? undefined : cells[col(name)]);
    facts.tickets.push({
      id: cells[0],
      group: GROUP_OF_GLYPH[state?.[1] ?? ""] ?? "unknown",
      state: state?.[2] ?? cells[col("STATE")]!,
      time: at("TIME")?.replace(/ ?~\S+$/, ""),
      left: at("TIME")?.match(/~\S+$/)?.[0],
      commits: at("COMMITS"),
      cpuMem: at("CPU/MEM"),
      tokens: at("TOKENS"),
      note: cells[col("ACTIVITY")]!,
      link: links.get(cells[0]),
    });
  }

  // The footer's counts.
  for (const line of lines.slice(end)) {
    for (const { text } of cellsOf(line)) {
      const m = text.trim().match(/^(\S) ([a-z ]+?) (\d+)$/);
      if (m && GROUP_OF_GLYPH[m[1]!]) facts.counts[m[2]!] = Number(m[3]);
    }
  }
  return facts;
};

/** Whether two values of one fact agree: an unknown one agrees with anything, a text cut with `…` with any text it starts. */
export const agree = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined || a === b) return true;
  const cut = (s: string, whole: string) => s.endsWith("…") && whole.startsWith(s.slice(0, -1));
  return cut(a, b) || cut(b, a);
};

/** Where two readings of a frame disagree, one line each; empty when they agree. */
export const compareFacts = (a: Facts, b: Facts): string[] => {
  const diffs: string[] = [];
  const check = (what: string, x: string | undefined, y: string | undefined) => agree(x, y) || diffs.push(`${what}: ${JSON.stringify(x)} against ${JSON.stringify(y)}`);
  for (const key of ["name", "base", "clock", "unpushed"] as const) check(`project ${key}`, a.project[key], b.project[key]);
  for (const key of new Set([...Object.keys(a.run), ...Object.keys(b.run)])) check(`run ${key}`, a.run[key], b.run[key]);
  check("settings", a.settings?.join(" · "), b.settings?.join(" · "));
  check("usage", a.usage, b.usage);
  check("hint", String(a.hint), String(b.hint));
  for (const group of new Set([...Object.keys(a.counts), ...Object.keys(b.counts)])) check(`count ${group}`, String(a.counts[group]), String(b.counts[group]));
  const ids = (f: Facts) => f.tickets.map((t) => t.id).join(" ");
  check("tickets shown, in order", ids(a), ids(b));
  for (const t of a.tickets) {
    const u = b.tickets.find((x) => x.id === t.id);
    if (!u) continue;
    for (const key of ["group", "state", "time", "commits", "cpuMem", "tokens", "note", "link"] as const) check(`${t.id} ${key}`, t[key], u[key]);
  }
  return diffs;
};

// ---------------------------------------------------------------------------
// The live view on a terminal, driven from outside.
//
// The live view is started on a pty (`script`), and a test waits for what it draws, then does what a
// person or Herdr would: types keys, sends Ctrl-C as a byte, resizes the pane, sends INT, TERM or HUP to
// the view's pid. Nothing here depends on how the view waits between frames, so the same test holds the
// bash loop and a Node one. (A fake `sleep` on PATH only ever runs in the bash loop.)
//
// A pane's size and the pty's flags are read and changed from a helper the wrapper starts inside the
// pty, which takes its commands from a FIFO: `script` cannot resize the terminal it made, and a
// process on the slave side can (`stty rows R cols C`), which signals the view as a resize does.
// The keys typed reach `script` through a pipe that `cat` fills from a second FIFO. Never the FIFO or
// Node's stdio itself: macOS builds a FIFO on a socket, as Node does a stdio pipe, and BSD `script`
// exits at once on either (`tcgetattr/ioctl: Operation not supported on socket`) where util-linux's
// carries on. A pipe(2) gives BSD's `tcgetattr` the ENOTTY it accepts.
// ---------------------------------------------------------------------------

/** Whether `script(1)` is installed: a test that needs a terminal skips without it. */
export const hasScript = spawnSync("script", ["--version"], { stdio: "ignore" }).error === undefined;
export const needsScript = { skip: hasScript ? false : "script(1) is not installed" };


/** BSD sets PENDIN (0x20000000) in lflag whenever a tty goes back to canonical mode, so a restored state reads one bit apart on macOS though nothing is left changed. Linux never reports it. */
export const settledTty = (stty: string) => stty.replace(/\blflag=([0-9a-f]+)/, (_, hex: string) => `lflag=${(parseInt(hex, 16) & ~0x20000000).toString(16)}`);

/** Polls `check` until it returns something other than `undefined`; rejects with `what` after `ms`. A poll of the outside world (a file, the output so far), not a pause the view could be timed on. */
export const until = async <T>(what: string, check: () => T | undefined, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`gave up after ${ms / 1000}s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

export type Painted = { /** The frame as drawn, colour and links in. */ raw: string; /** Without them. */ text: string; /** Where in the output it ends. */ end: number };

export type SessionOptions = {
  /** The view's arguments: its interval, and "all" for every row. Default `["30"]`: a frame, then idle until something is sent. */
  args?: string[];
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
};

export type Ended = {
  /** The view's exit status as its shell saw it: 130 for Ctrl-C, INT and TERM, 128 + n when a signal killed it. */
  status: number;
  /** `stty -g` before the view started and after it ended. */
  before: string;
  after: string;
};

export type Session = {
  /** The view's pid (the wrapper `exec`s into the view). */
  pid: number;
  /** Everything the view has written so far. */
  output: () => string;
  /** The complete frames painted from `from` on: from a cursor-home to the erase below it. */
  frames: (from?: number) => Painted[];
  /** Waits for a frame painted from `from` on (and satisfying `want`, when given). */
  frame: (from?: number, want?: (frame: Painted) => boolean, ms?: number) => Promise<Painted>;
  /** Types `bytes` into the terminal. */
  send: (bytes: string) => void;
  /** Resizes the pane (the view is signalled as for a resize). */
  resize: (rows: number, cols: number) => void;
  /** The pty's flags (`stty -a`), read while the view runs. */
  flags: () => Promise<string>;
  signal: (name: NodeJS.Signals) => void;
  /** Waits for the view to end and its shell to read the terminal back; fails with `after` named when it does not. */
  ended: (after: string, ms?: number) => Promise<Ended>;
  /** Ends whatever is left - the view, its wrapper and every command the view has in flight - and returns once all of it has exited. */
  close: () => void;
};

const sessions = new Set<() => void>();
process.once("exit", () =>
  sessions.forEach((close) => {
    try {
      close();
    } catch {
      // the process is exiting: what is left is reported by nothing that would still run
    }
  }),
);

type Listed = { pid: number; ppid: number; pgid: number; zombie: boolean };

/** Every process on the machine, from one `ps` (the same columns on BSD and procps). */
const processes = (): Listed[] =>
  spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8" })
    .stdout.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 4)
    .map(([pid, ppid, pgid, stat]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), zombie: stat!.startsWith("Z") }));

/** `roots` and every process descended from them, by parent pid. */
const sessionTree = (listed: Listed[], roots: number[]): Listed[] => {
  const found = listed.filter((p) => roots.includes(p.pid));
  for (let i = 0; i < found.length; i++) found.push(...listed.filter((p) => p.ppid === found[i]!.pid && !found.includes(p)));
  return found;
};

/** Waits, synchronously (an `afterEach` that does not await it still waits), until no process of `groups` and none of `pids` is running; a zombie holds nothing. */
const awaitGone = (groups: Set<number>, pids: Set<number>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = processes().filter((p) => (groups.has(p.pgid) || pids.has(p.pid)) && !p.zombie);
    if (left.length === 0) return;
    if (Date.now() > deadline) throw new Error(`a status session's processes did not end ${ms / 1000}s after SIGKILL: ${left.map((p) => p.pid).join(" ")}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};

/** Starts the live view of `fixture` on a pty. Call `close()` when the test is done. */
export const startSession = async (fixture: Fixture, { args = ["30"], env = {}, rows = 60, cols = 100 }: SessionOptions = {}): Promise<Session> => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-status-session-"));
  const [ctl, input] = ["ctl", "in"].map((n) => join(dir, n));
  for (const fifo of [ctl!, input!]) execFileSync("mkfifo", [fifo]);
  const files = { wrapper: join(dir, "wrapper.pid"), pid: join(dir, "pid"), status: join(dir, "status"), before: join(dir, "before"), after: join(dir, "after") };
  const { command, args: commandArgs } = statusCommand(args);
  writeFileSync(join(dir, "view.sh"), `#!/bin/sh\necho $$ >${quote(files.pid)}\nexec ${[command, ...commandArgs].map(quote).join(" ")}\n`);
  // The helper answers the FIFO's commands inside the pty. INT is caught (not ignored, which the view would inherit): Ctrl-C
  // reaches this shell too, and it must outlive the view to read the terminal back.
  writeFileSync(
    join(dir, "wrapper.sh"),
    `#!/bin/sh
echo $$ >${quote(files.wrapper)}
stty rows ${rows} cols ${cols} </dev/tty
stty -g </dev/tty >${quote(files.before)}
( while read -r verb a b; do
    case "$verb" in
      size) stty rows "$a" cols "$b" </dev/tty ;;
      flags) stty -a </dev/tty >"$a.tmp" 2>&1; mv "$a.tmp" "$a" ;;
    esac
  done <${quote(ctl!)} ) &
helper=$!
trap : INT
sh ${quote(join(dir, "view.sh"))}
echo $? >${quote(files.status)}
stty -g </dev/tty >${quote(files.after)}
kill $helper 2>/dev/null
`,
  );
  chmodSync(join(dir, "wrapper.sh"), 0o755);
  const inFd = openSync(input!, "r+");
  const ctlFd = openSync(ctl!, "r+");
  const wrapper = join(dir, "wrapper.sh");
  const scriptArgs = process.platform === "linux" ? ["-qec", `sh ${quote(wrapper)}`, "/dev/null"] : ["-q", "/dev/null", "sh", wrapper];
  fixture.mark = readFileSync(fixture.pids, "utf8").split("\n").filter(Boolean).length;
  const sessionEnv: NodeJS.ProcessEnv = { ...viewEnv(fixture, { SANDCASTLE_LINKS: "", HERDR_ENV: "", ...env }) };
  for (const name of ["TERM_COLS", "TERM_ROWS", "COLUMNS", "LINES"]) delete sessionEnv[name];
  // `exec` keeps `script` the child, so `done` is its end; `cat` ends by itself once `inFd` (the FIFO's only writer) closes.
  const child: ChildProcess = spawn("bash", ["-c", 'fifo=$1; shift; exec "$@" < <(exec cat "$fifo")', "session", input!, "script", ...scriptArgs], {
    env: sessionEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let gone = false;
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
  const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
  void done.then(() => (gone = true));
  let inputOpen = true;
  const endInput = () => {
    if (!inputOpen) return;
    inputOpen = false;
    closeSync(inFd);
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sessions.delete(close);
    // A view killed outright cannot end the commands it has in flight: each runs in a process group of its own
    // (src/status-snapshot.ts), so they outlive it, and a fake that starts late appends its pid to the fixture's
    // `fake-pids` after the test's `after` hook has begun removing the fixture, which then finds its directory not
    // empty (ENOTEMPTY). The wrapper, once its view is gone, writes the status and the terminal's state into `dir`
    // the same way. So the view is frozen first, where it can start nothing new, and every group of the processes
    // under `script` (the wrapper, the view, its commands) is killed and waited for before anything is removed.
    // Only while `script` is unreaped: its pid, and so the tree under it, is still this session's.
    const signal = (pid: number, name: NodeJS.Signals) => {
      try {
        process.kill(pid, name);
      } catch {
        // already gone
      }
    };
    const tree: Listed[] = [];
    const groups = new Set<number>();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const viewPid = existsSync(files.pid) ? Number(readFileSync(files.pid, "utf8")) : 0;
      if (sessionTree(processes(), [child.pid]).some((p) => p.pid === viewPid)) signal(viewPid, "SIGSTOP");
      const listed = processes();
      const own = listed.find((p) => p.pid === process.pid)?.pgid;
      tree.push(...sessionTree(listed, [child.pid]));
      for (const p of tree) if (p.pgid !== own && p.pgid > 1) groups.add(p.pgid);
      for (const group of groups) signal(-group, "SIGKILL");
      for (const p of tree) signal(p.pid, "SIGKILL");
    }
    child.kill("SIGKILL");
    endInput();
    try { closeSync(ctlFd); } catch { /* closed */ }
    awaitGone(groups, new Set(tree.map((p) => p.pid)));
    rmSync(dir, { recursive: true, force: true });
  };
  sessions.add(close);

  const frames = (from = 0): Painted[] => {
    const found: Painted[] = [];
    for (const m of out.matchAll(/\u001b\[H([\s\S]*?)\u001b\[J/g)) {
      const end = m.index! + m[0].length;
      if (m.index! >= from) found.push({ raw: m[1]!.replace(/\r\n/g, "\n"), text: plain(m[1]!.replace(/\r\n/g, "\n")), end });
    }
    return found;
  };
  const pid = await until("the view to start", () => {
    if (existsSync(files.pid) && readFileSync(files.pid, "utf8").trim()) return Number(readFileSync(files.pid, "utf8"));
    // A `script` that cannot make the terminal ends at once: fail with its words, not after the wait.
    if (gone) throw new Error(`script ended before the view started: ${err.trim() || out.trim() || "no output"}`);
    return undefined;
  });
  const session: Session = {
    pid,
    output: () => out,
    frames,
    frame: (from = 0, want = () => true, ms = 30_000) => until("a frame", () => frames(from).find(want), ms),
    send: (bytes) => void writeSync(inFd, bytes),
    resize: (r, c) => void writeSync(ctlFd, `size ${r} ${c}\n`),
    flags: async () => {
      const file = join(dir, `flags-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      writeSync(ctlFd, `flags ${file}\n`);
      return until("the terminal's flags", () => (existsSync(file) ? readFileSync(file, "utf8") : undefined));
    },
    signal: (name) => process.kill(pid, name),
    ended: async (after, ms = 20_000) => {
      // BSD `script` outlives its child until its stdin ends, so the input is closed once the wrapper has read the
      // terminal back (`after` is its last write); util-linux's has ended by then.
      let waiting = true;
      const wrappedUp = (async () => {
        while (waiting && !gone && !existsSync(files.after)) await new Promise((resolve) => setTimeout(resolve, 10));
        if (waiting) endInput();
        await done;
        return true;
      })();
      const exited = await Promise.race([wrappedUp, new Promise<false>((resolve) => setTimeout(() => resolve(false), ms))]);
      waiting = false;
      if (!exited) throw new Error(`the view did not end ${ms / 1000}s after ${after} (output ends ${JSON.stringify(out.slice(-80))})`);
      return { status: Number(readFileSync(files.status, "utf8")), before: readFileSync(files.before, "utf8"), after: readFileSync(files.after, "utf8") };
    },
    close,
  };
  return session;
};

/** The processes the fixture's fakes have logged (`docker`, `gh`, `git`, `sandcastle`) since the latest view started: every one that view started that way. */
export const started = (fixture: Fixture): { pid: number; name: string }[] =>
  readFileSync(fixture.pids, "utf8").split("\n").filter(Boolean).slice(fixture.mark).map((line) => ({ pid: Number(line.split(" ")[0]), name: line.split(" ")[1]! }));

/** Whether the process is running (a zombie is not: it is waiting for its parent, and holds nothing). */
const running = (pid: number): boolean => {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
};

/**
 * The orphan check: the commands of the fixture's fakes (docker, gh, git, sandcastle) that the view started and
 * that are still running, once the view has ended. A moment is given for a child of a view that was just
 * signalled to finish its own exit; one still there after it is an orphan.
 */
export const orphans = async (fixture: Fixture, ms = 5_000): Promise<string[]> => {
  const left = () => started(fixture).filter((p) => running(p.pid));
  let found = left();
  try {
    await until("the view's processes to end", () => ((found = left()).length === 0 ? true : undefined), ms);
  } catch {
    // still running: reported below
  }
  return found.map(({ pid, name }) => `${name} ${pid}`);
};
