// How a test starts the status view: through the implementation switch, so one black-box test holds
// either view to the same facts. `SANDCASTLE_TEST_STATUS_IMPL` is `bash` (status.sh, the default) or
// `ts` (the TypeScript view, once it exists). Its name passes test/hermetic-env.ts, which scrubs
// SANDCASTLE_* but not SANDCASTLE_TEST_*.
//
// `statusCommand` is the one place a test names the view's entry. `runStatus` draws one frame and
// returns it; `statusSession` (further down) starts the live view on a terminal and drives it from
// outside, as a person or Herdr would.

import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnSyncOptions, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KIT, kitArgs } from "./cli-spawn.ts";
import { fixtureEnv, type Fixture } from "./status-fixture.ts";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export type Impl = "bash" | "ts";

/** The TypeScript view's entry: the one line the ticket that adds it sets. */
export const TS_ENTRY = join(KIT, "src/status-view.ts");
/** The preload that gives the TypeScript view the fixture clock (`SANDCASTLE_TEST_NOW`); the bash view gets it from the fixture's `date`. */
const TS_CLOCK = join(KIT, "test/status-clock.ts");

/** Which view the black-box status tests start. */
export const impl = (): Impl => {
  const chosen = process.env.SANDCASTLE_TEST_STATUS_IMPL || "bash";
  if (chosen !== "bash" && chosen !== "ts") throw new Error(`SANDCASTLE_TEST_STATUS_IMPL is "${chosen}": bash or ts`);
  return chosen;
};

/** The command that starts the chosen view with `args` (its interval, then "all" for every row). */
export const statusCommand = (args: string[]): { command: string; args: string[] } => {
  if (impl() === "bash") return { command: process.env.STATUS_BASH || "bash", args: [join(KIT, "status.sh"), ...args] };
  if (!existsSync(TS_ENTRY)) throw new Error(`SANDCASTLE_TEST_STATUS_IMPL=ts: the TypeScript status view (${TS_ENTRY}) does not exist yet`);
  return { command: process.execPath, args: [...kitArgs("--import", TS_CLOCK, TS_ENTRY, ...args)] };
};

/** `spawnSync` of the chosen view with `args`: what a black-box test calls where it used to name status.sh. */
export function spawnStatus(args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnStatus(args: string[], options: SpawnSyncOptionsWithBufferEncoding): SpawnSyncReturns<Buffer>;
export function spawnStatus(args: string[], options: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  const { command, args: viewArgs } = statusCommand(args);
  return spawnSync(command, viewArgs, options);
}

/** The arguments of `script(1)` that run the chosen view with `args` on a pty: util-linux and BSD spell it differently. Give `script` no stdin (`stdio: ["ignore", ...]`): BSD refuses the socket Node passes. */
export const scriptArgs = (args: string[]): string[] => {
  const { command, args: viewArgs } = statusCommand(args);
  return process.platform === "linux" ? ["-qec", [command, ...viewArgs].map(quote).join(" "), "/dev/null"] : ["-q", "/dev/null", command, ...viewArgs];
};

/** A UTF-8 locale for the bash view's widths (Linux runners often have only C.UTF-8); none found is fine for the TypeScript one. */
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
  /** The labelled cells of the header (`state`, `ends`, `tokens`, `sandboxes`, `gates`, `this run`, `waiting`, `models`), their values with the gauge bars out. */
  run: Record<string, string>;
  /** The settings row's items; the autonomy scale is reduced to the level chosen. */
  settings: string[];
  usage?: string;
  tickets: TicketFacts[];
  /** The footer's count of each group. */
  counts: Record<string, number>;
  /** Whether the click hint is shown. */
  hint: boolean;
};

const HEADER_LABELS = ["state", "since", "ends", "started", "finished", "tokens", "sandboxes", "gates", "this run", "waiting", "models", "settings", "usage"];
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const noBars = (s: string) => squash(s.replace(/[░▒▓█▌▏▎▍▋▊▉]+/g, " "));

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

  // The header: the logo's lines, then labelled cells. A cell with a label starts a field; an unlabelled one under it (same column) continues it.
  let current = new Map<number, string>();
  const fields = new Map<string, string>();
  for (const line of lines.slice(0, header)) {
    if (!line.startsWith("│")) {
      current = new Map();
      continue;
    }
    const name = line.match(/█████\s+(\S+)/);
    if (name) facts.project.name = name[1];
    const base = line.match(/base (\S+)(?: ↑(\d+) unpushed)?\s+·\s+(\d\d:\d\d:\d\d)/);
    if (base) Object.assign(facts.project, { base: base[1], clock: base[3], ...(base[2] ? { unpushed: `↑${base[2]} unpushed` } : {}) });
    for (const { x, text } of cellsOf(line)) {
      const body = text.trim();
      if (!body || body.startsWith("base ") || (/[▄█]/.test(body) && !HEADER_LABELS.some((l) => body.startsWith(l)))) continue;
      const label = HEADER_LABELS.find((l) => new RegExp(`^${l}(\\s|$)`).test(body));
      if (label) {
        current.set(x, label);
        fields.set(label, body.slice(label.length));
      } else if (current.has(x)) {
        const key = current.get(x)!;
        fields.set(key, `${fields.get(key)} ${body}`);
      } else {
        // A wide layout drops the label of the models cell: the one unlabelled cell with text is the models.
        current.set(x, "models");
        fields.set("models", body);
      }
    }
  }
  for (const [label, value] of fields) {
    if (label === "settings") {
      facts.settings = noBars(value)
        .replace(/autonomy [\d ]*\[(\w+)\][\w ]*?(?= ·|$)/, "autonomy $1")
        // A narrow pane wraps the row where an item starts, with no separator: the bullet marks the item.
        .split(/\s+·\s+|\s+(?=[●○] )/)
        .map(squash);
    } else if (label === "usage") facts.usage = noBars(value);
    else if (label === "models") {
      // An ended run's models are the last run's, said as a prefix in a narrow pane and as a suffix in a wide one.
      const models = noBars(value).replace(/^last run: /, "").replace(/ \(last run\)$/, "");
      facts.run.models = models;
      if (models !== noBars(value)) facts.run["models from"] = "last run";
    } else facts.run[label] = noBars(value);
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
      time: at("TIME"),
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
  check("settings", a.settings.join(" · "), b.settings.join(" · "));
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
// `script`'s stdin is that FIFO too, not the socket Node would pass: BSD's refuses a socket.
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
  /** Ends whatever is left. */
  close: () => void;
};

const sessions = new Set<() => void>();
process.once("exit", () => sessions.forEach((close) => close()));

/** Starts the live view of `fixture` on a pty. Call `close()` when the test is done. */
export const startSession = async (fixture: Fixture, { args = ["30"], env = {}, rows = 60, cols = 100 }: SessionOptions = {}): Promise<Session> => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-status-session-"));
  const [ctl, input] = ["ctl", "in"].map((n) => join(dir, n));
  for (const fifo of [ctl!, input!]) execFileSync("mkfifo", [fifo]);
  const files = { pid: join(dir, "pid"), status: join(dir, "status"), before: join(dir, "before"), after: join(dir, "after") };
  const { command, args: commandArgs } = statusCommand(args);
  writeFileSync(join(dir, "view.sh"), `#!/bin/sh\necho $$ >${quote(files.pid)}\nexec ${[command, ...commandArgs].map(quote).join(" ")}\n`);
  // The helper answers the FIFO's commands inside the pty. INT is caught (not ignored, which the view would inherit): Ctrl-C
  // reaches this shell too, and it must outlive the view to read the terminal back.
  writeFileSync(
    join(dir, "wrapper.sh"),
    `#!/bin/sh
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
  const child: ChildProcess = spawn("script", scriptArgs, { env: sessionEnv, stdio: [inFd, "pipe", "pipe"] });
  let out = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  child.stderr!.on("data", () => {});
  const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sessions.delete(close);
    const pid = existsSync(files.pid) ? Number(readFileSync(files.pid, "utf8")) : 0;
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    child.kill("SIGKILL");
    for (const fd of [inFd, ctlFd]) try { closeSync(fd); } catch { /* closed */ }
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
  const pid = await until("the view to start", () => (existsSync(files.pid) && readFileSync(files.pid, "utf8").trim() ? Number(readFileSync(files.pid, "utf8")) : undefined));
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
      const exited = await Promise.race([done.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), ms))]);
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

// Run as a script, it starts the chosen view with its own arguments and ends as the view does: how
// test/status.test.sh, a shell script, starts the view through the same switch.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { command, args } = statusCommand(process.argv.slice(2));
  process.exitCode = spawnSync(command, args, { stdio: "inherit" }).status ?? 1;
}
