// Plan usage guard, opt-in with USAGE_CHECK=1.
//
// A spent allowance already stops the queue (burndown.ts, LIMIT) - but only
// after an agent hits it, with the sandboxes in flight half done. Reading the
// plan's usage windows before each issue starts lets a run stop short of the
// wall instead. The endpoint is the one Claude Code's own usage view reads:
// undocumented and hard rate-limited (it answered 429 on 20260930 while a
// bogus token got 401), so the reading is cached for ten minutes and fails
// open - an unknown reading never blocks a run.

export const USAGE_CHECK = process.env.USAGE_CHECK === "1";
const USAGE_STOP = Number(process.env.USAGE_STOP ?? 90);
if (!(USAGE_STOP > 0 && USAGE_STOP <= 100)) throw new Error(`USAGE_STOP=${process.env.USAGE_STOP} - expected 1 to 100.`);

type Window = { kind: string; percent: number };
let cache: { at: number; windows?: Window[] } | undefined;

// Two payload shapes are in use: a `limits` list, and older top-level
// `five_hour` / `seven_day` objects. Both report percentages.
const parse = (payload: Record<string, unknown>): Window[] => {
  const limits = payload.limits as { kind?: string; percent?: number }[] | undefined;
  if (limits?.length) return limits.map((l) => ({ kind: String(l.kind ?? "?"), percent: Number(l.percent ?? 0) }));
  return (["five_hour", "seven_day"] as const).flatMap((key) => {
    const w = payload[key] as { utilization?: number } | undefined;
    return w?.utilization == null ? [] : [{ kind: key, percent: Number(w.utilization) }];
  });
};

const read = async (token: string): Promise<Window[] | undefined> => {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.windows;
  let windows: Window[] | undefined;
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) windows = parse((await r.json()) as Record<string, unknown>);
  } catch {
    /* unknown - fail open */
  }
  cache = { at: Date.now(), windows: windows?.length ? windows : undefined };
  return cache.windows;
};

const describe = (windows: Window[]) => windows.map((w) => `${w.kind} ${Math.round(w.percent)}%`).join(" · ");

/** One line for the run's start, or undefined when the check is off. */
export const usageLine = async (env: Record<string, string>) => {
  if (!USAGE_CHECK) return undefined;
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) return "Plan usage: not checked - it needs CLAUDE_CODE_OAUTH_TOKEN, not an API key.";
  const windows = await read(env.CLAUDE_CODE_OAUTH_TOKEN);
  return windows
    ? `Plan usage: ${describe(windows)} (no new issue starts at ${USAGE_STOP}%).`
    : "Plan usage: unknown right now (the endpoint is rate-limited); the run goes ahead.";
};

/** Why no further issue should start, or undefined to carry on. */
export const usageStop = async (env: Record<string, string>) => {
  if (!USAGE_CHECK || !env.CLAUDE_CODE_OAUTH_TOKEN) return undefined;
  const windows = await read(env.CLAUDE_CODE_OAUTH_TOKEN);
  const over = windows?.filter((w) => w.percent >= USAGE_STOP);
  return over?.length ? `plan usage ${describe(over)} reached USAGE_STOP=${USAGE_STOP}%` : undefined;
};
