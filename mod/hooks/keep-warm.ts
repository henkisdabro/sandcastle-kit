// The cache refresh: while a run this session started is live, the session sits idle and Claude
// Code's prompt cache lapses after an hour of silence (5 minutes on overage), so the turn that
// closes the run would re-read the whole conversation at the full input price. A refresh is one
// tool-less request over the main thread's transcript (`$.model.fork`), which reads it from the
// cache at about a tenth of that price and resets the timer. Pure, and like idle.ts it imports
// nothing: register.tsx gathers the facts and this module decides.

/** A refresh is due when the session has been silent this long: under the 1-hour lifetime, with margin. */
export const INTERVAL_MS = 55 * 60 * 1000;

/** The last refresh: when, how many tokens it read from the cache, and how large the context was. */
export type Refresh = { at: number; cacheRead: number; contextTokens: number };

/** One of the plan's usage windows (`$.session.usage().rateLimits`); only the fill matters here. */
export type PlanWindow = { percentUsed: number };

/** What the session remembers across looks; it lives in `$.state`, since a reload restarts module variables. */
export type Warmth = {
  /** The run these facts are about (its `startedAt`): another run starts them over, so misses are counted per run. */
  run?: string;
  /** The last refresh, until a main-thread turn ends after a miss: that turn clears the miss. */
  last?: Refresh;
  /** The refreshes this run that found the cache lapsed. */
  misses: number;
  /** When the main thread's last turn ended. */
  turnEnd?: number;
};

export type KeepWarmInput = {
  /** The run record's `settings.keepWarm`; absent reads as on. */
  enabled?: boolean;
  /** A run this session started or follows is live (a paused run is live). */
  live: boolean;
  /** The later of the main thread's last turn end and the last refresh; absent is "just now". */
  lastActivity?: number;
  last?: Refresh;
  /** The refreshes of this run that found the cache lapsed. */
  misses?: number;
  /** The plan's windows; none for an API key or a gateway. */
  rateLimits?: PlanWindow[];
  now: number;
};

export type KeepWarmVerdict = {
  refresh: boolean;
  /** `1h`: refreshing; `5m`: the cache is short-lived, so it is left to lapse; `off`: nothing to do. */
  mode: "1h" | "5m" | "off";
  /** When the next refresh is due, ms since the epoch; only in `1h` mode. */
  nextAt?: number;
  /** The row the band draws; absent when there is nothing to say. */
  band?: string;
};

/** A refresh whose cache read was under half the context: the cache had lapsed. */
export const missed = (last: Refresh): boolean => last.cacheRead < last.contextTokens / 2;

/** The most misses a run puts up with: the second turns the refresh off for the run. */
const MAX_MISSES = 2;

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * Whether to refresh now, and the band's text. Overage (any window at 100%) or a refresh that
 * found the cache lapsed mean a 5-minute cache: keeping it warm takes about 13 refreshes an hour
 * (about 1.3x the input price), against one cold re-write at about 1.25x, so it costs more for
 * any wait over an hour and is left alone. With no windows (an API key, a gateway) nothing is
 * assumed: the first refresh's measured read decides.
 */
export const keepWarm = (input: KeepWarmInput): KeepWarmVerdict => {
  const { now, last } = input;
  if (input.enabled === false || !input.live || (input.misses ?? 0) >= MAX_MISSES) return { refresh: false, mode: "off" };
  if ((input.rateLimits ?? []).some((w) => w.percentUsed >= 100) || (last !== undefined && missed(last))) {
    return { refresh: false, mode: "5m", band: "cache 5m · not warmed (a cold restart costs less)" };
  }
  const lastActivity = input.lastActivity ?? now;
  const nextAt = lastActivity + INTERVAL_MS;
  if (now >= nextAt) return { refresh: true, mode: "1h", nextAt };
  const band =
    last !== undefined && last.at >= lastActivity
      ? `cache refreshed ${clock(last.at)} · ${tokens(last.cacheRead)} read`
      : `cache warm · refresh in ${Math.max(1, Math.ceil((nextAt - now) / 60000))}m`;
  return { refresh: false, mode: "1h", nextAt, band };
};

/** The most recent thing that kept the cache warm: a main-thread turn, a refresh, or the run's start. */
export const activity = (kept: Warmth, floor?: number): number | undefined => {
  const times = [kept.turnEnd, kept.last?.at, floor].filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return times.length === 0 ? undefined : Math.max(...times);
};

/**
 * What a refresh found. `result` is `$.model.fork`'s: an answered one carries the request's usage;
 * one that is not (`api-error`, `aborted`) is a miss, since nothing says the cache held.
 */
export const settle = (kept: Warmth, result: { isAnswered: boolean; usage?: { cache_read_input_tokens?: number } }, contextTokens: number, at: number): Warmth => {
  const cacheRead = result.isAnswered ? Math.max(0, result.usage?.cache_read_input_tokens ?? 0) : 0;
  const last: Refresh = { at, cacheRead, contextTokens: result.isAnswered ? contextTokens : Math.max(contextTokens, 1) };
  return { ...kept, last, misses: kept.misses + (missed(last) ? 1 : 0) };
};

/** A main-thread turn ended: the cache was just used, and a miss before it is cleared (one more try at 55 minutes). */
export const afterTurn = (kept: Warmth, at: number): Warmth => {
  const { last, ...rest } = kept;
  return { ...rest, turnEnd: at, ...(last !== undefined && !missed(last) ? { last } : {}) };
};

/**
 * What a refresh writes back: its own facts, and a main-thread turn that ended while its request was out (`stored`,
 * the state as it is now). Written as read before the request, that turn's end would be lost.
 */
export const withLaterTurn = (kept: Warmth, stored: Warmth): Warmth =>
  stored.turnEnd !== undefined && stored.turnEnd > (kept.turnEnd ?? -Infinity) ? afterTurn(kept, stored.turnEnd) : kept;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A stored value as `Warmth`; anything else reads as nothing remembered. */
export const parseWarmth = (value: unknown): Warmth => {
  if (typeof value !== "object" || value === null) return { misses: 0 };
  const { run, last, misses, turnEnd } = value as Record<string, unknown>;
  const l = typeof last === "object" && last !== null ? (last as Record<string, unknown>) : undefined;
  return {
    ...(typeof run === "string" ? { run } : {}),
    misses: finite(misses) && misses > 0 ? Math.floor(misses) : 0,
    ...(finite(turnEnd) ? { turnEnd } : {}),
    ...(l && finite(l.at) && finite(l.cacheRead) && finite(l.contextTokens) ? { last: { at: l.at, cacheRead: l.cacheRead, contextTokens: l.contextTokens } } : {}),
  };
};
