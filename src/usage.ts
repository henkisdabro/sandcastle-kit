// Plan usage guard, opt-in with USAGE_CHECK=1.
//
// A spent allowance already stops the queue (burndown.ts, LIMIT) - but only
// after an agent hits it, with the sandboxes in flight half done. Reading the
// plan's usage windows before each issue starts lets a run stop short of the
// wall instead. The endpoint is the one Claude Code's own usage view reads:
// undocumented and hard rate-limited (it answered 429 on 20260930 while a
// bogus token got 401), so a reading is cached for ten minutes and fails
// open - an unknown reading never blocks a run. A failed reading is asked for again before the next
// ticket, except a 403 (this token cannot read usage): that turns the guard off for the run.

import { OperatorError } from "./errors.ts";

export const USAGE_CHECK = process.env.USAGE_CHECK === "1";

/** The stop threshold a USAGE_STOP value gives (90 when unset or empty); a value outside 1 to 100 is refused. */
export const parseUsageStop = (value: string | undefined) => {
  const stop = Number(value || 90);
  if (!(stop > 0 && stop <= 100)) throw new OperatorError(`USAGE_STOP=${value} - expected 1 to 100.`);
  return stop;
};

// Read only when the check is on: a bad USAGE_STOP must not break `sandcastle doctor`, which never
// uses it, or `status`, whose settings row leaves the next run's settings unresolved instead.
const usageStopPercent = () => parseUsageStop(process.env.USAGE_STOP);

/** Refuses a bad USAGE_STOP when the run starts - before the image, preflight or any spend - not at the first reading. */
export const checkUsageSettings = () => {
  if (USAGE_CHECK) usageStopPercent();
};

type Window = { kind: string; percent: number };
// The reading, or the request for it that is in flight - one request serves
// every worker, so parallel workers do not each spend the rate limit.
let cache: { at: number; windows: Promise<Reading> } | undefined;

// Two payload shapes are in use: a `limits` list, and top-level window
// objects (`five_hour`, `seven_day`, per-model `seven_day_*`) carrying
// `utilization`. Both report percentages.
const parse = (payload: Record<string, unknown>): Window[] => {
  const limits = payload.limits as { kind?: string; percent?: number }[] | undefined;
  if (limits?.length) return limits.map((l) => ({ kind: String(l.kind ?? "?"), percent: Number(l.percent ?? 0) }));
  return Object.entries(payload).flatMap(([key, value]) => {
    const w = value as { utilization?: number } | null;
    return typeof w === "object" && w?.utilization != null ? [{ kind: key, percent: Number(w.utilization) }] : [];
  });
};

// Windows, or why there are none: the start line said "rate-limited" for every failure. `off` is a
// 403: the token cannot read plan usage, which no retry changes, so the guard is off for the run.
type Reading = Window[] | { why: string; off?: true };
const fetchWindows = async (token: string): Promise<Reading> => {
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 403) return { why: "the usage endpoint answered HTTP 403: this token cannot read plan usage", off: true };
    if (!r.ok) return { why: `the usage endpoint answered HTTP ${r.status}${r.status === 429 ? ", rate-limited" : r.status === 401 ? ", token refused" : ""}` };
    const windows = parse((await r.json()) as Record<string, unknown>);
    return windows.length ? windows : { why: "the usage endpoint's answer had no usage windows" };
  } catch {
    return { why: "the usage endpoint did not answer" }; // unknown - fail open
  }
};

/** The HTTP status the usage endpoint gives a token (401 for a bad one), undefined when there was no answer. `sandcastle doctor --verify` uses it; the status says nothing else. */
export const probeOAuth = async (token: string): Promise<number | undefined> => {
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    return r.status;
  } catch {
    return undefined;
  }
};

// A 403 is final for the run: the endpoint is asked no more. The token it was told of is kept, so a
// different token (a later turn after a config change) is asked afresh.
let forbidden: { token: string; reading: Reading } | undefined;

const read = (token: string): Promise<Reading> => {
  if (forbidden?.token === token) return Promise.resolve(forbidden.reading);
  if (!cache || Date.now() - cache.at >= 10 * 60_000) {
    const windows = fetchWindows(token).then((reading) => {
      if (!Array.isArray(reading)) {
        // A reading that failed is not kept: the line promises another ask before each ticket, and a
        // rate limit that has lifted should not wait out the ten minutes. Workers in flight still share this one.
        if (cache?.windows === windows) cache = undefined;
        if (reading.off) forbidden = { token, reading };
      }
      return reading;
    });
    cache = { at: Date.now(), windows };
  }
  return cache.windows;
};

// What the last attempt to read the plan's usage got, as a fact for the run record: the guard is
// guarding only while it has a reading. Undefined until the guard has asked.
let lastReading: "got" | "none" | undefined;

/** True when the guard's last attempt got no reading (a 403, a rate limit, no OAuth token): it is not guarding right now. */
export const usageReadingLost = () => lastReading === "none";

const describe = (windows: Window[]) => windows.map((w) => `${w.kind} ${Math.round(w.percent)}%`).join(" · ");

/** One line for the run's start, or undefined when the check is off. */
export const usageLine = async (env: Record<string, string>) => {
  if (!USAGE_CHECK) return undefined;
  const stop = usageStopPercent();
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    lastReading = "none";
    return "Plan usage: not checked - it needs CLAUDE_CODE_OAUTH_TOKEN, not an API key.";
  }
  const windows = await read(env.CLAUDE_CODE_OAUTH_TOKEN);
  lastReading = Array.isArray(windows) ? "got" : "none";
  if (Array.isArray(windows)) return `Plan usage: ${describe(windows)} (no new ticket starts at ${stop}%).`;
  if (windows.off) return `Plan usage: the usage guard is off for this run (${windows.why}; USAGE_CHECK=1 cannot work with it, and the endpoint is not asked again).`;
  return `Plan usage: unknown right now (${windows.why}); the run goes ahead, and checks again before each ticket starts.`;
};

/** Why no further issue should start, or undefined to carry on. */
export const usageStop = async (env: Record<string, string>) => {
  if (!USAGE_CHECK) return undefined;
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    lastReading = "none";
    return undefined;
  }
  const stop = usageStopPercent();
  const windows = await read(env.CLAUDE_CODE_OAUTH_TOKEN);
  lastReading = Array.isArray(windows) ? "got" : "none";
  const over = Array.isArray(windows) ? windows.filter((w) => w.percent >= stop) : undefined;
  return over?.length ? `plan usage ${describe(over)} reached USAGE_STOP=${stop}%` : undefined;
};
