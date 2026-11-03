// `sandcastle slot <n> --instance <id>`: what a herdr-core slot terminal runs (src/herdr-core.ts, `openCoreView`).
// It tails the slot's log link, `herdr-pane-N.log`, which the run repoints per phase, as a Herdr 1 sandbox pane does,
// and tells the core which ticket and step it shows: the terminal's root record (OSC 7501) and title (OSC 2), written
// when the run's slot state changes. Its own entry (`bin/sandcastle` runs it alone, as `herdr`), so its command line
// never names `src/cli.ts`, which `liveness` reads as a run.
//
// It ends itself, with nothing left behind (`--rm`): once the run is not live by the one rule (`liveness`,
// mod/hooks/run-live.ts) - a run killed with no exit handler - or once the project's view record names another run
// instance, a later run's. No sweep, so no later run's slot is ever ended by mistake.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveness, type Probe } from "../mod/hooks/run-live.ts";
import { helpFor, wantsHelp } from "./help.ts";
import { readCoreView, readSlotState, slotLink, slotStateFile } from "./herdr-core.ts";
import { commandOf } from "./live-runs.ts";
import { clear, record, windowTitle } from "./osc7501.ts";

/**
 * An agent's log as plain text: every control character but newline and tab goes, ESC and the C1 controls with it,
 * so an escape sequence a log holds - an OSC 7501 an agent printed, say - is shown as inert text and never sets this
 * terminal's record or title. Character by character, so a sequence split across two reads is caught all the same.
 */
// oxlint-disable-next-line no-control-regex -- the control characters are what is being removed
export const plainLog = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** The run behind the project's record is live: the lock's pid, else the unfinished record's, is the kit's. */
const runLive = (root: string, probe: Probe) => {
  const logs = join(root, ".sandcastle/logs");
  let record: object | undefined;
  let lockPid: number | undefined;
  try {
    record = JSON.parse(readFileSync(join(logs, "run.json"), "utf8"));
  } catch {
    /* none yet, or half-written: the lock decides */
  }
  try {
    lockPid = Number(readFileSync(join(logs, "run.lock"), "utf8").split(" ")[0]);
  } catch {
    /* no lock */
  }
  return liveness({ record, lockPid }, probe).state === "live";
};

export type SlotOptions = { root?: string; out?: { write(s: string): unknown }; probe?: Probe; pollMs?: number; stop?: AbortSignal };

/** Runs the slot until its run is over or no longer the project's; resolves with the exit code. */
export const runSlot = (args: string[], { root = process.cwd(), out = process.stdout, probe = commandOf, pollMs = 1000, stop }: SlotOptions = {}): Promise<number> => {
  const n = Number(args[0]);
  const at = args.indexOf("--instance");
  const instance = at >= 0 ? args[at + 1] : undefined;
  if (!Number.isInteger(n) || n < 0 || !instance) {
    out.write("Usage: sandcastle slot <n> --instance <id> - what a herdr-core sandbox terminal runs.\n");
    return Promise.resolve(2);
  }
  // tail's own follow-by-name (-F): it reopens the link once it points at the next phase's log. Its notes about
  // that go to stderr, dropped. Relative to the project root, the terminal's cwd.
  const tail = spawn("tail", ["-n", "40", "-F", slotLink(root, n)], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  tail.stdout.setEncoding("utf8");
  tail.stdout.on("data", (chunk: string) => out.write(plainLog(chunk)));
  tail.on("error", () => {}); // no tail: the records still go on

  let said = "";
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      tail.kill();
      // The terminal is gone with it (`--rm`); its record goes first all the same.
      out.write(clear());
      resolve(code);
    };
    const look = () => {
      if (readCoreView(root)?.instance !== instance || !runLive(root, probe)) return end(0);
      const s = readSlotState(slotStateFile(root, n));
      const now = s ? JSON.stringify(s) : "";
      if (s && now !== said) {
        const line = `${s.ref} ${s.title}`;
        out.write(record({ state: s.state, app: "sandcastle", title: line, msg: s.phase }) + windowTitle(`${line} · ${s.phase}`));
      }
      said = now;
      timer = setTimeout(look, pollMs);
    };
    stop?.addEventListener("abort", () => end(0));
    look();
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(3);
  if (wantsHelp(args)) console.log(helpFor("slot"));
  else {
    // `hc kill`, a hangup or Ctrl-C: tail is ended with it, not left reading for nobody.
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => stop.abort());
    process.exit(await runSlot(args, { stop: stop.signal }));
  }
}
