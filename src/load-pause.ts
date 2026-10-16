// LOAD_PAUSE: a run holds each gate pass while the machine's CPU pressure is high.
//
// A gate pass starts whatever else the machine is doing, and test gates on a host held at a high load run
// several times slower than on a quiet one and go red on their timeouts. So a gate pass waits, before it takes
// its gates slot, until the machine's CPU pressure (`readMachineCpu`, PSI `some` `avg60`) has stayed under the
// threshold for a while. Only gate passes wait: agent passes go on, and this is not the `PauseSource` pause
// `USAGE_PAUSE` takes, which parks tickets and closes their sandboxes. A run holds for 30 minutes in all, then
// every hold releases and the run holds nothing again - a machine that never quietens must not stop the drain.
import type { MachineCpu } from "./peaks.ts";
import { OperatorError } from "./errors.ts";

/** The threshold, in percent, a run holds gate passes at when neither `LOAD_PAUSE` nor the project's `loadPause` says. */
export const DEFAULT_LOAD_PAUSE = 60;

/** Readings stay under the threshold this long before a hold releases. */
export const LOAD_RELEASE_MS = 120_000;

/** The most time a run holds gate passes in all, before every hold releases. */
export const LOAD_GIVE_UP_MS = 1_800_000;

/**
 * The threshold a LOAD_PAUSE value, else the project's `loadPause`, gives: 60 when neither is set, undefined when it is
 * turned off (`LOAD_PAUSE=0`, `loadPause: false`). A value that is neither is refused, naming where it came from.
 */
export const parseLoadPause = (value: string | undefined, config?: unknown): number | undefined => {
  if (value) {
    if (value.trim() === "0") return undefined;
    const percent = value.trim() === "" ? NaN : Number(value);
    if (!(percent >= 1 && percent <= 100)) throw new OperatorError(`LOAD_PAUSE=${value} - expected 0 (off) or 1 to 100.`);
    return percent;
  }
  if (config === undefined) return DEFAULT_LOAD_PAUSE;
  if (config === false) return undefined;
  if (!(typeof config === "number" && config >= 1 && config <= 100)) throw new OperatorError(`loadPause=${JSON.stringify(config)} in the project config - expected false (off) or 1 to 100.`);
  return config;
};

/** The ports of a load pause: every one injectable, so a test runs on a fake clock and a fake reader. */
export type LoadPausePorts = {
  /** The threshold in percent: a reading's `avg60` at or over it holds. */
  threshold: number;
  /** The machine's CPU pressure now; `readMachineCpu` in a run. */
  read: () => MachineCpu | undefined;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  say: (line: string) => void;
  /** Called when the run's held total or `gaveUp` changes (at most once per `pollMs` while holding, and at each release and the give-up). */
  onChange?: (change: { heldMs: number; gaveUp: boolean }) => void;
  pollMs?: number;
  releaseMs?: number;
  giveUpMs?: number;
};

export type LoadPause = {
  /** Waits, when the machine is busy, until it has been quiet; returns at once otherwise. `onHold` is called once, when this hold begins. */
  hold: (label: string, onHold?: () => void) => Promise<void>;
  /** The run's wall time with at least one hold in progress. */
  heldMs: () => number;
  gaveUp: () => boolean;
  /** Sets who is told of changes besides the `onChange` the pause was made with (a turn's run record); undefined stops it. */
  listen: (onChange: ((change: { heldMs: number; gaveUp: boolean }) => void) | undefined) => void;
};

const minutes = (ms: number) => {
  const m = ms / 60_000;
  return m === 1 ? "1 minute" : `${Number.isInteger(m) ? m : m.toFixed(1)} minutes`;
};

export const createLoadPause = (ports: LoadPausePorts): LoadPause => {
  const { threshold, read, now, sleep, say } = ports;
  const pollMs = ports.pollMs ?? 10_000;
  const releaseMs = ports.releaseMs ?? LOAD_RELEASE_MS;
  const giveUpMs = ports.giveUpMs ?? LOAD_GIVE_UP_MS;
  let listener = ports.onChange;
  // Held time is the wall time with a hold in progress: two passes held together count once.
  let closed = 0;
  let active = 0;
  let since = 0;
  let gave = false;
  let endGiveUp: () => void = () => {};
  const gaveUpSignal = new Promise<void>((resolve) => (endGiveUp = resolve));
  const heldMs = () => closed + (active ? now() - since : 0);
  let last: { heldMs: number; gaveUp: boolean } | undefined;
  let lastAt = -Infinity;
  const emit = () => {
    const change = { heldMs: heldMs(), gaveUp: gave };
    if (last && last.heldMs === change.heldMs && last.gaveUp === change.gaveUp) return;
    last = change;
    lastAt = now();
    listener?.(change);
  };
  const enter = () => {
    if (!active) since = now();
    active++;
  };
  const leave = () => {
    active--;
    if (active) return;
    closed += now() - since;
    emit();
  };
  const giveUp = () => {
    if (gave) return;
    gave = true;
    say(`Load pause: held gate passes ${minutes(giveUpMs)} in all - giving up; later gate passes run under load`);
    emit();
    endGiveUp();
  };
  const words = (r: MachineCpu, label: string) =>
    `Load pause: the machine's CPU pressure is ${r.avg60}% (some avg60${r.estimate ? ", an estimate from the load average" : ""}, at or over ${threshold}%) - ${label} waits until it is under ${threshold}% for ${minutes(releaseMs)}`;

  const hold = async (label: string, onHold?: () => void): Promise<void> => {
    if (gave) return;
    const first = read();
    if (!first || first.avg60 < threshold) return;
    onHold?.();
    say(words(first, label));
    enter();
    try {
      let quietSince: number | undefined;
      for (;;) {
        const left = giveUpMs - heldMs();
        if (left <= 0) {
          giveUp();
          return;
        }
        await Promise.race([sleep(Math.min(pollMs, left)), gaveUpSignal]);
        if (gave) return;
        if (heldMs() >= giveUpMs) {
          giveUp();
          return;
        }
        if (now() - lastAt >= pollMs) emit();
        const r = read();
        // No reading is no evidence of load: the hold ends rather than wait on a machine it cannot see.
        if (!r) return;
        if (r.avg60 >= threshold) {
          quietSince = undefined;
          continue;
        }
        quietSince ??= now();
        if (now() - quietSince >= releaseMs) return;
      }
    } finally {
      leave();
    }
  };

  return {
    hold,
    heldMs,
    gaveUp: () => gave,
    listen: (onChange) => {
      listener = onChange;
      last = undefined;
    },
  };
};

/**
 * The start line for the hold: what it waits for and how to turn it off; on macOS that the reading is an estimate, and with
 * no reading that this machine gives none, so the run never holds.
 */
export const loadPauseLine = (percent: number, reading: MachineCpu | undefined) =>
  reading
    ? `Load pause: gate passes wait while the machine's CPU pressure is at or over ${percent}% (some avg60${reading.estimate ? ", an estimate from the load average" : ""}), ${minutes(LOAD_GIVE_UP_MS)} in all per run; LOAD_PAUSE=0 turns it off`
    : `Load pause: at ${percent}%, but this machine gives no CPU pressure reading, so the run never holds (LOAD_PAUSE=0 turns it off)`;

/** The run record's `loadPause` for a change: the running total, and `gaveUp` only when true. */
export const loadRecord = (change: { heldMs: number; gaveUp: boolean }): { heldMs: number; gaveUp?: true } => ({ heldMs: change.heldMs, ...(change.gaveUp ? { gaveUp: true as const } : {}) });
