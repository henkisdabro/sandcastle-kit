// Plan usage guard, opt-in with USAGE_CHECK=1.
//
// A spent allowance already stops the queue (burndown.ts, LIMIT) - but only
// after an agent hits it, with the sandboxes in flight half done. Reading the
// plan's usage windows before each issue starts lets a run stop short of the
// wall instead. The endpoint is the one Claude Code's own usage view reads:
// undocumented and hard rate-limited (it answered 429 on 20260930 while a
// bogus token got 401), so the reading is cached for ten minutes and fails
// open - an unknown reading never blocks a run.

import { OperatorError } from "./errors.ts";

export const USAGE_CHECK = process.env.USAGE_CHECK === "1";

// Read only when the check is on: a bad USAGE_STOP must not break
// `sandcastle doctor` or `status`, which never use it.
const usageStopPercent = () => {
  const stop = Number(process.env.USAGE_STOP || 90);
  if (!(stop > 0 && stop <= 100)) throw new OperatorError(`USAGE_STOP=${process.env.USAGE_STOP} - expected 1 to 100.`);
  return stop;
};

type Window = { kind: string; percent: number };
// The reading, or the request for it that is in flight - one request serves
// every worker, so parallel workers do not each spend the rate limit.
let cache: { at: number; windows: Promise<Window[] | undefined> } | undefined;

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

const fetchWindows = async (token: string): Promise<Window[] | undefined> => {
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return undefined;
    const windows = parse((await r.json()) as Record<string, unknown>);
    return windows.length ? windows : undefined;
  } catch {
    return undefined; // unknown - fail open
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

const read = (token: string) => {
  if (!cache || Date.now() - cache.at >= 10 * 60_000) cache = { at: Date.now(), windows: fetchWindows(token) };
  return cache.windows;
};

const describe = (windows: Window[]) => windows.map((w) => `${w.kind} ${Math.round(w.percent)}%`).join(" · ");

/** One line for the run's start, or undefined when the check is off. */
export const usageLine = async (env: Record<string, string>) => {
  if (!USAGE_CHECK) return undefined;
  const stop = usageStopPercent();
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) return "Plan usage: not checked - it needs CLAUDE_CODE_OAUTH_TOKEN, not an API key.";
  const windows = await read(env.CLAUDE_CODE_OAUTH_TOKEN);
  return windows
    ? `Plan usage: ${describe(windows)} (no new issue starts at ${stop}%).`
    : "Plan usage: unknown right now (the endpoint is rate-limited); the run goes ahead.";
};

/** Why no further issue should start, or undefined to carry on. */
export const usageStop = async (env: Record<string, string>) => {
  if (!USAGE_CHECK || !env.CLAUDE_CODE_OAUTH_TOKEN) return undefined;
  const stop = usageStopPercent();
  const windows = await read(env.CLAUDE_CODE_OAUTH_TOKEN);
  const over = windows?.filter((w) => w.percent >= stop);
  return over?.length ? `plan usage ${describe(over)} reached USAGE_STOP=${stop}%` : undefined;
};
