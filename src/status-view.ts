// The status view in TypeScript (ADR 0003): `status.sh` hands every view to it when the test switch says so
// (`SANDCASTLE_TEST_STATUS_IMPL=ts`), with the same arguments, environment and exit codes, until it takes over
// (#707). It reads a snapshot (src/status-snapshot.ts), works out the rows (src/status-rows.ts) and draws one
// frame (src/status-render.ts) in a single write.
//
//   status-view.ts [interval] [all|collapse]
//
// `0`, or any interval with no terminal on stdout (and no STATUS_FRAMES), is one frame and out: exit 0, or 1 when
// the project has no `.sandcastle`, as status.sh's. Any other interval is the live view: a frame every `interval`
// seconds on the alternate screen, until q or Esc in the Herdr popup (0), Ctrl-C or INT (130, and the quit mark),
// TERM (130) or HUP (129). STATUS_FRAMES ends it after that many frames, for the tests.
//
// Each live frame is drawn by this file again in a child process (`--frame`) in a process group of its own: the
// snapshot is read synchronously (git, docker and the queue as child processes), so a signal that lands while
// one is in flight is handled at once, and that group is ended with the view on every way out - nothing it
// started is left running. Herdr finds the view's pane by this file's name in its command line (src/herdr.ts).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { fit, visibleWidth } from "./status-grid.ts";
import { palette, renderFrame } from "./status-render.ts";
import { ticketRows } from "./status-rows.ts";
import { readSnapshot, sandcastleDir } from "./status-snapshot.ts";

const ENTRY = fileURLToPath(import.meta.url);
const digits = (s: string | undefined): s is string => !!s && /^[0-9]+$/.test(s);
const pause = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `stty` on the controlling terminal: what it printed, or undefined without a terminal or when it failed. */
const stty = (...args: string[]): string | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync("/dev/tty", "r");
    const r = spawnSync("stty", args, { stdio: [fd, "pipe", "ignore"], encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** The pane's size from its terminal (`stty size`), or undefined without one: a pty that reports 0 0 counts as none. */
const terminalSize = (): { cols: string; rows: string } | undefined => {
  const m = /^([1-9][0-9]*) ([1-9][0-9]*)$/.exec(stty("size") ?? "");
  return m ? { rows: m[1]!, cols: m[2]! } : undefined;
};

/** The pane's size, asked afresh: a resize changes it. A size given (the tests, the frame checks) wins over the terminal's. */
const paneSize = (env: NodeJS.ProcessEnv): { cols: number; rows: number } => {
  let cols = env.TERM_COLS;
  let rows = env.TERM_ROWS;
  if (!cols) ({ cols, rows } = terminalSize() ?? { cols, rows });
  if (!digits(cols)) cols = digits(env.COLUMNS) ? env.COLUMNS : String(process.stdout.columns || 100);
  if (!digits(rows)) rows = String(process.stdout.rows || 40);
  return { cols: Number(cols), rows: Number(rows) };
};

type FrameAsk = { cols: number; rows: number; showAll: boolean; terminal: boolean };

const drawFrame = (dir: string, env: NodeJS.ProcessEnv, { cols, rows, showAll, terminal }: FrameAsk): string => {
  const snapshot = readSnapshot(dir, { env, terminal });
  const colours = palette(!env.NO_COLOR && terminal, env.COLORTERM === "truecolor" || env.COLORTERM === "24bit");
  return renderFrame(snapshot, ticketRows(snapshot), { cols, rows, showAll, colours });
};

/**
 * A live frame's lines, each cut to the pane. Line wrap is off, so a line that fills the pane leaves the cursor on
 * its last cell, where an erase-to-end would wipe that cell: only a shorter line is followed by one (`\e[K`), which
 * clears what the previous frame left to its right. The frame ends in a newline on a row of its own.
 */
const liveBody = (frame: string, cols: number): string =>
  frame
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const cut = fit(line, cols);
      return visibleWidth(cut) < cols ? `${cut}\x1b[K` : cut;
    })
    .join("\n") + "\n";

/** Writes all of `text` to stdout: synchronously, so nothing is lost when the view exits after it. False when stdout is gone. */
const out = (text: string): boolean => {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; ) {
    try {
      at += writeSync(1, bytes, at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") return false;
      pause(5);
    }
  }
  return true;
};

/**
 * Ctrl-C in the run's own status pane is a person quitting the view: the view record says so (`quit`), and the tab
 * bar then leaves that shell to them instead of typing the view back into it every tick (src/herdr.ts,
 * `restartStatusView`). INT only: a Herdr server stop sends HUP, and the view must come back after the restart; a
 * TERM is nobody's choice either. One read and a rename, as the pane may be torn down before a slow exit ends. The
 * pane is checked against the record, so the plugin's popup and a view a person opened elsewhere mark nothing, and
 * a run that reuses the pane (src/herdr.ts) rewrites the record without `status` before it sends the Ctrl-C.
 */
const markQuit = (dir: string, env: NodeJS.ProcessEnv) => {
  if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return;
  const file = join(dir, "logs/herdr-view.json");
  const tmp = `${file}.${process.pid}.quit`;
  try {
    const view = JSON.parse(readFileSync(file, "utf8"));
    if (!view || typeof view !== "object" || view.status !== env.HERDR_PANE_ID) return;
    writeFileSync(tmp, JSON.stringify({ ...view, quit: true }) + "\n");
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
};

/** Whether this process is its terminal's foreground: a background view that read or set the terminal would be stopped (SIGTTIN, SIGTTOU). */
const inForeground = (): boolean => {
  const r = spawnSync("ps", ["-o", "pgid=", "-o", "tpgid=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  const [pgid, tpgid] = (r.stdout ?? "").trim().split(/\s+/);
  return !pgid || !tpgid || pgid === tpgid;
};

const ESC = 0x1b;
const CTRL_C = 0x03;
/** What a live view writes to give the terminal back: alternate scroll and line wrap on, the cursor shown, the main screen. */
const LEAVE = "\x1b[?1007h\x1b[?7h\x1b[?25h\x1b[?1049l";

const live = (dir: string, env: NodeJS.ProcessEnv, interval: string, showAll: boolean, terminal: boolean) => {
  const n = Number(interval);
  const waitMs = (Number.isFinite(n) && n > 0 ? n : 10) * 1000;
  let framesLeft = env.STATUS_FRAMES ? Number(env.STATUS_FRAMES) || 0 : undefined;
  // Stray errors from a frame land in STATUS_ERRLOG, never mid-frame where the cursor happens to be.
  let errlog: number | "ignore" = "ignore";
  try {
    if (env.STATUS_ERRLOG) errlog = openSync(env.STATUS_ERRLOG, "a");
  } catch {
    /* no log: dropped */
  }

  // The input side too, when there is a terminal: in cooked mode the kernel echoes every key at the cursor (on the
  // frame's free bottom row) and keeps it queued for the shell once the view exits. So echo is off and input
  // unbuffered (-icanon), and the view reads and drops what is typed. `min 1`, not status.sh's `min 0`: a read that
  // returns nothing is the end of input to Node. isig stays on: Ctrl-C at a keyboard signals the view, and a Ctrl-C
  // that arrives as a byte all the same (a terminal in raw mode) is taken as INT below.
  const foreground = inForeground();
  const saved = foreground ? stty("-g") : undefined;
  const raw = !!saved && stty("-echo", "-icanon", "min", "1", "time", "0") !== undefined;
  const reading = raw && isatty(0);
  // In the Herdr plugin's popup, which only closes when this exits: q or Esc does it.
  const keys = !!env.SANDCASTLE_STATUS_KEYS && reading;

  let done = false;
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let escTimer: NodeJS.Timeout | undefined;
  let last = "";

  /** Ends the frame in flight and everything it started: the whole process group, a command it waits on included. */
  const stopChild = () => {
    const pid = child?.pid;
    child = undefined;
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };
  /** Drops what is still typed and unread, so it does not reach the shell once the view is gone. */
  const drain = () => {
    let fd: number | undefined;
    try {
      fd = openSync("/dev/tty", constants.O_RDONLY | constants.O_NONBLOCK);
      const buf = Buffer.alloc(1024);
      for (let i = 0; i < 4 && readSync(fd, buf, 0, buf.length, null) > 0; i++);
    } catch {
      /* nothing left, or no terminal */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const restore = () => {
    if (reading) process.stdin.pause();
    if (raw) {
      drain();
      stty(saved!);
    }
    out(LEAVE);
  };
  const finish = (code: number) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearTimeout(escTimer);
    stopChild();
    restore();
    process.exit(code);
  };
  const interrupt = () => {
    if (done) return;
    markQuit(dir, env);
    finish(130);
  };
  // INT must end the view, not only put the screen back. A hangup is the pane gone (a Herdr server stop), not a
  // person quitting: no mark, and the code a hangup kills with. An error that escapes still gives the terminal back.
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", () => finish(130));
  process.on("SIGHUP", () => finish(129));
  process.on("exit", () => {
    if (done) return;
    done = true;
    stopChild();
    restore();
  });

  const draw = () => {
    clearTimeout(timer);
    // One frame at a time: a resize during one draws again when it is in (below).
    if (done || child) return;
    const size = paneSize(env);
    const chunks: Buffer[] = [];
    const frame = spawn(process.execPath, [...process.execArgv, ENTRY, "--frame", String(size.cols), String(size.rows), showAll ? "all" : "collapse", terminal ? "tty" : "pipe"], {
      detached: true,
      stdio: ["ignore", "pipe", errlog],
    });
    child = frame;
    frame.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    frame.on("error", () => {});
    frame.on("close", (code) => {
      if (child !== frame || done) return;
      child = undefined;
      const now = paneSize(env);
      // A frame drawn for a size the pane no longer has is dropped for one at the new size.
      if (now.cols !== size.cols || now.rows !== size.rows) return draw();
      const body = Buffer.concat(chunks).toString("utf8");
      // A frame that failed with nothing drawn keeps the last one on screen; its error is in STATUS_ERRLOG.
      if (code === 0 || body) {
        last = body;
        // Cursor home, the frame, then erase below it: one write, so a refresh replaces the screen and is never seen row by row.
        out(`\x1b[H${body}\x1b[J`);
        if (framesLeft !== undefined && --framesLeft <= 0) return finish(0);
      }
      timer = setTimeout(draw, waitMs);
    });
  };

  // Redraw on a pane resize instead of waiting out the interval, and put the last frame's top back at the new
  // height at once: a frame takes seconds (docker, git, the queue), and a shrunk pane would show the old frame's
  // tail, header scrolled off, until then.
  process.on("SIGWINCH", () => {
    if (done) return;
    if (last) {
      const { rows } = paneSize(env);
      out(`\x1b[H${last.replace(/\n$/, "").split("\n").slice(0, Math.max(rows - 1, 1)).join("\n")}\n\x1b[J`);
    }
    draw();
  });

  if (reading) {
    process.stdin.on("data", (bytes: Buffer) => {
      if (done) return;
      if (bytes.includes(CTRL_C)) return interrupt();
      if (!keys) return;
      // An arrow key is Esc and more, sent at once, and must not close the popup; Esc alone has nothing after it.
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = undefined;
        return draw();
      }
      if (bytes[0] === 0x71 || bytes[0] === 0x51) return finish(0);
      if (bytes.length === 1 && bytes[0] === ESC) {
        escTimer = setTimeout(() => finish(0), 50);
        return;
      }
      // Any other key redraws now, as status.sh's popup does.
      draw();
    });
    process.stdin.on("error", () => {});
  }

  // Alternate screen and hidden cursor, restored on exit. Line wrap off as well: a line wider than the pane would
  // wrap onto a second row, and enough of them push the frame's top off the screen. The wheel's alternate scroll
  // (?1007) off, so it does not arrive as arrow keys.
  out("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1007l\x1b[2J");
  draw();
};

/** `status-view.ts --frame <cols> <rows> <all|collapse> <tty|pipe>`: one live frame, for the live view's child. */
const frameChild = (dir: string, env: NodeJS.ProcessEnv, [cols, rows, show, stdout]: string[]): number => {
  const ask = { cols: Number(cols) || 100, rows: Number(rows) || 40, showAll: show === "all", terminal: stdout === "tty" };
  out(liveBody(drawFrame(dir, env, ask), ask.cols));
  return 0;
};

const main = (): number | undefined => {
  const env = process.env;
  const dir = sandcastleDir(env);
  if (!dir) {
    process.stderr.write(`status: ${resolve(env.SANDCASTLE_PROJECT || process.cwd(), ".sandcastle")}: No such file or directory\n`);
    return 1;
  }
  const argv = process.argv.slice(2);
  if (argv[0] === "--frame") return frameChild(dir, env, argv.slice(1));
  const [interval = "10", show] = argv;
  const terminal = isatty(1);
  // Nobody watches a refreshing view whose output is not a terminal, and a pipe or an agent's tool would wait on it
  // until killed: with no terminal any interval prints once, as 0 does. STATUS_FRAMES keeps the loop for the tests.
  const once = interval === "0" || (!terminal && !env.STATUS_FRAMES);
  // A one-off frame prints every row; a refreshing one fits the pane unless asked for "all".
  const showAll = (show || (once ? "all" : "collapse")) === "all";
  if (!once) {
    live(dir, env, interval, showAll, terminal);
    return undefined;
  }
  process.stdout.write(drawFrame(dir, env, { ...paneSize(env), showAll, terminal }));
  return 0;
};

// The exit code without process.exit: a frame written into a pipe is flushed before the process ends.
const code = main();
if (code !== undefined) process.exitCode = code;
