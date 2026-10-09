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
//
// The guard applies only when the sandboxes spend a subscription token (`CLAUDE_CODE_OAUTH_TOKEN`):
// with `ANTHROPIC_API_KEY` they spend API credits, which no plan's usage describes, so it says it does
// not apply - beside an OAuth token too, since Claude Code puts the API key first. Then the token comes from the host's Claude Code login when there is a readable one
// (`usageToken`): a `claude setup-token` token is inference-only and the endpoint answers it 403, while
// the login's access token carries the `user:profile` scope. The kit cannot tell whether the login and
// the token are one account, so the start line and `doctor --verify` say whose plan is read. It is read on the host, at each reading, and only
// ever sent to the usage endpoint: never refreshed (a refresh rotates the token and could sign
// Claude Code out), never written anywhere, never in a sandbox's environment or mounts, never printed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { PlanUsage, PlanWindow, RunRecord, UsagePaused } from "../mod/hooks/run-record.ts";
import { OperatorError } from "./errors.ts";
import type { Tokens } from "./run.ts";
import type { Change } from "./schedule.ts";

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

/** What the guard reads the plan's usage with: the Claude Code login's access token, the setup token, a login that has run out, or nothing because the sandboxes spend an API key (no plan to read). */
export type UsageToken = { source: "login" | "CLAUDE_CODE_OAUTH_TOKEN"; token: string } | { source: "login expired" } | { source: "api key" } | undefined;

/** Whose plan a reading is of, for the start line and `doctor --verify`: the host login's account, or the setup token's. */
export const usageWhose = (source: "login" | "CLAUDE_CODE_OAUTH_TOKEN") =>
  source === "login"
    ? "the Claude Code login's account on this machine (the sandboxes spend CLAUDE_CODE_OAUTH_TOKEN, assumed to be the same account)"
    : "CLAUDE_CODE_OAUTH_TOKEN's account (no readable Claude Code login on this machine)";

/** The host's Claude Code login as JSON text, or undefined when there is none to read. Injected, so a test needs no real keychain or file. */
export type LoginReaders = { keychain(): string | undefined; file(): string | undefined };

const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The keychain service Claude Code keeps its login under: with `CLAUDE_CONFIG_DIR` set, the name takes
 * the first 8 hex characters of the SHA-256 of that value (a trailing slash removed first) as a suffix,
 * so reading the plain name finds nothing, or another configuration's login; with it unset or empty, the plain name.
 */
export const keychainService = (configDir = process.env.CLAUDE_CONFIG_DIR) => {
  const dir = configDir?.replace(/\/+$/, "");
  return dir ? `${KEYCHAIN_SERVICE}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}` : KEYCHAIN_SERVICE;
};

/** Where the guard looks for the host's Claude Code login on `platform`, for `doctor --verify` to name (a service or file name, never the token). */
export const loginLocation = (platform: NodeJS.Platform = process.platform) =>
  platform === "darwin" ? `keychain service "${keychainService()}"` : `credentials file ${join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json")}`;

/** The real readers: the macOS keychain's generic password (`keychainService`), and `.credentials.json` under `CLAUDE_CONFIG_DIR` (else `~/.claude`). A failure is no login. */
export const hostLoginReaders: LoginReaders = {
  keychain: () => {
    try {
      return execFileSync("security", ["find-generic-password", "-s", keychainService(), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    } catch {
      return undefined;
    }
  },
  file: () => {
    try {
      return readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json"), "utf8");
    } catch {
      return undefined;
    }
  },
};

/**
 * The token a usage reading is made with, when the sandboxes spend a subscription token
 * (`CLAUDE_CODE_OAUTH_TOKEN` in `env` and no `ANTHROPIC_API_KEY`, which Claude Code spends first, as
 * `credentialSource` has it): the host's Claude Code login (macOS keychain, else the credentials file)
 * while it has not expired, else that token. Otherwise the host login is never read: an API key is
 * `api key` (no plan is spent), and nothing at all is nothing. An
 * expired login is its own answer, not a reason to fall back: the setup token would only get a 403,
 * which turns the guard off for the whole run, while the login comes back when Claude Code next
 * refreshes it. A missing or unreadable login (no entry, malformed JSON, no access token) falls
 * back. The login's `expiresAt` is in milliseconds; nothing here refreshes or writes anything.
 */
export const usageToken = (
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  readers: LoginReaders = hostLoginReaders,
  now = Date.now(),
): UsageToken => {
  if (env.ANTHROPIC_API_KEY) return { source: "api key" };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) return undefined;
  const login = (() => {
    try {
      const raw = platform === "darwin" ? readers.keychain() : readers.file();
      const oauth = (JSON.parse(raw ?? "") as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)?.claudeAiOauth;
      return typeof oauth?.accessToken === "string" && oauth.accessToken ? { token: oauth.accessToken, expiresAt: Number(oauth.expiresAt) } : undefined;
    } catch {
      return undefined;
    }
  })();
  // No usable expiry is read as expired: a token of unknown age is not sent.
  if (login) return login.expiresAt > now ? { source: "login", token: login.token } : { source: "login expired" };
  return { source: "CLAUDE_CODE_OAUTH_TOKEN", token: env.CLAUDE_CODE_OAUTH_TOKEN };
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

/** True when the guard's last attempt got no reading (a 403, a rate limit, no token or an expired login): it is not guarding right now. */
export const usageReadingLost = () => lastReading === "none";

// What the endpoint calls each window, which the stop line names them by whichever reading it is made from.
const ENDPOINT_KIND = { fiveHour: "five_hour", week: "seven_day" } as const;

const describe = (windows: Window[]) => windows.map((w) => `${w.kind} ${Math.round(w.percent)}%`).join(" · ");

/** One line for the run's start, or undefined when the check is off. */
export const usageLine = async (env: Record<string, string>, readers: LoginReaders = hostLoginReaders) => {
  if (!USAGE_CHECK) return undefined;
  const stop = usageStopPercent();
  const credential = usageToken(env, process.platform, readers);
  if (!credential) {
    lastReading = "none";
    return "Plan usage: not checked - it needs the sandboxes to spend a subscription token (CLAUDE_CODE_OAUTH_TOKEN), and none is set.";
  }
  if (credential.source === "api key") {
    lastReading = "none";
    return "Plan usage: the guard does not apply - the sandboxes spend ANTHROPIC_API_KEY (API credits, no plan), so there is no plan usage to read; USAGE_CHECK=1 does nothing for this run.";
  }
  if (!("token" in credential)) {
    lastReading = "none";
    return "Plan usage: unknown right now (the Claude Code login has expired; any use of Claude Code on this machine refreshes it); the run goes ahead, and checks again before each ticket starts.";
  }
  const windows = await read(credential.token);
  lastReading = Array.isArray(windows) ? "got" : "none";
  const whose = ` Read for ${usageWhose(credential.source)}.`;
  if (Array.isArray(windows)) return `Plan usage: ${describe(windows)} (no new ticket starts at ${stop}%).${whose}`;
  if (windows.off) return `Plan usage: the usage guard is off for this run (${windows.why}; USAGE_CHECK=1 cannot work with it, and the endpoint is not asked again).${whose}`;
  return `Plan usage: unknown right now (${windows.why}); the run goes ahead, and checks again before each ticket starts.${whose}`;
};

/** How young the newest agent reading must be for the guard to use it in place of the endpoint (seconds): the endpoint's own reading is cached as long. */
export const AGENT_READING_FRESH_SECONDS = 10 * 60;

/**
 * Why no further issue should start, or undefined to carry on. The newest reading of the run's own Claude
 * agents (`agent`: `usage` in the run record) is used when it is younger than ten minutes, and then the
 * endpoint is not asked and no credential is read; before the first reading, and once the newest is older, the
 * endpoint answers as it always did. A window whose reset has passed since the reading counts as spent no more.
 */
export const usageStop = async (env: Record<string, string>, readers: LoginReaders = hostLoginReaders, agent?: () => PlanUsage | undefined, now = Date.now) => {
  if (!USAGE_CHECK) return undefined;
  const seconds = Math.floor(now() / 1000);
  const newest = agent?.();
  if (newest?.windows && newest.at !== undefined && seconds - newest.at < AGENT_READING_FRESH_SECONDS) {
    lastReading = "got";
    const stop = usageStopPercent();
    const over = openWindows([newest], seconds).filter((w) => w.percent >= stop);
    return over.length ? `plan usage ${over.map((w) => `${ENDPOINT_KIND[w.window]} ${w.percent}%`).join(" · ")} reached USAGE_STOP=${stop}%` : undefined;
  }
  const credential = usageToken(env, process.platform, readers);
  if (!credential || !("token" in credential)) {
    lastReading = "none";
    return undefined;
  }
  const stop = usageStopPercent();
  const windows = await read(credential.token);
  lastReading = Array.isArray(windows) ? "got" : "none";
  const over = Array.isArray(windows) ? windows.filter((w) => w.percent >= stop) : undefined;
  return over?.length ? `plan usage ${describe(over)} reached USAGE_STOP=${stop}%` : undefined;
};

// ---------------------------------------------------------------------------
// The plan's usage on screen, from the agents' own readings.
//
// Claude Code's stream-json output carries `rate_limit_event` lines, about three a pass, with the 5-hour
// and the weekly window's utilisation and reset time. They are in each agent's raw `.jsonl` sidecar
// already (run.ts, `agentLogging`), so unlike the guard's endpoint above they cost no request: the run
// reads what its agents' logs gained since the last look, keeps the newest reading in the run record
// (`usage`) and the status view, the Herdr sidebar and the closing summary show it. It needs no
// credential and never asks the endpoint, so it is separate from the guard (`USAGE_CHECK`) and does
// not depend on it. Codex's readings (cross-review, on a ChatGPT plan) are the second reader, beside
// `usageFromEvent`: `USAGE_READERS` is keyed by provider, so a later provider adds one function there.
// ---------------------------------------------------------------------------

/** One reading of a provider's plan: what the record's `usage` holds an entry of once an agent has reported. */
export type UsageReading = Required<PlanUsage>;

/** A provider whose plan usage a run can show: Claude (the implement, review and repair passes) and Codex (the cross-review). */
export type UsageProvider = PlanUsage["provider"];

/** The bands the readers colour by: normal below `USAGE_AMBER` percent, amber from it, red from `USAGE_RED`. status.sh holds the same two numbers (it cannot import them). */
export const USAGE_AMBER = 75;
export const USAGE_RED = 90;
export const usageBand = (percent: number): "normal" | "amber" | "red" => (percent >= USAGE_RED ? "red" : percent >= USAGE_AMBER ? "amber" : "normal");

/** How often the run looks at its agents' logs, and the longest it goes between writes of the record. status.sh greys a reading older than `USAGE_STALE_SECONDS`. */
export const USAGE_INTERVAL_MS = 15_000;
export const USAGE_STALE_SECONDS = 15 * 60;

const windowOf = (value: unknown): PlanWindow | undefined => {
  const w = value as { utilization?: unknown; resetsAt?: unknown } | null | undefined;
  if (typeof w?.utilization !== "number" || typeof w.resetsAt !== "number" || !Number.isFinite(w.utilization) || !(w.resetsAt > 0) || !Number.isFinite(w.resetsAt)) return undefined;
  // Utilisation is a fraction of the window (0.92 is 92%).
  return { percent: Math.min(100, Math.max(0, Math.round(w.utilization * 100))), resetsAt: w.resetsAt };
};

/**
 * The reading a Claude Code `rate_limit_event` stream line holds, or undefined for any other line, a
 * malformed one, or an event without both windows. `at` is when the kit read the line, in seconds since
 * the epoch: the stream carries no time of its own, and an agent's clock is not the host's.
 */
export const usageFromEvent = (line: string, at: number): UsageReading | undefined => {
  if (!line.includes("rate_limit_event")) return undefined;
  let event: { type?: unknown; rate_limit_info?: { unifiedWindows?: { five_hour?: unknown; seven_day?: unknown } } | null } | null;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (event?.type !== "rate_limit_event") return undefined;
  const windows = event.rate_limit_info?.unifiedWindows;
  const fiveHour = windowOf(windows?.five_hour);
  const week = windowOf(windows?.seven_day);
  return fiveHour && week ? { provider: "claude", windows: { fiveHour, week }, at } : undefined;
};

// Codex's own windows. `used_percent` is already a percentage (42.0 is 42%), `window_minutes` says which
// window it is - the 5-hour one is 300, the week 10080 - and `resets_at` is seconds since the epoch.
const CODEX_FIVE_HOUR_MINUTES = 300;
const CODEX_WEEK_MINUTES = 10080;

const codexWindowOf = (value: unknown): (PlanWindow & { minutes: number }) | undefined => {
  const w = value as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null | undefined;
  if (typeof w?.used_percent !== "number" || typeof w.window_minutes !== "number" || typeof w.resets_at !== "number") return undefined;
  if (!Number.isFinite(w.used_percent) || !(w.resets_at > 0) || !Number.isFinite(w.resets_at)) return undefined;
  return { percent: Math.min(100, Math.max(0, Math.round(w.used_percent))), resetsAt: w.resets_at, minutes: w.window_minutes };
};

/**
 * The reading a Codex `rate_limits` object holds, or undefined without both windows. The windows are told
 * apart by their length (`window_minutes`: 300 and 10080), never by position: `primary` is the 5-hour one
 * today, but nothing promises that for every plan. `at` is when the kit read it, in seconds since the epoch.
 */
export const usageFromRateLimits = (limits: unknown, at: number): UsageReading | undefined => {
  const l = limits as { primary?: unknown; secondary?: unknown } | null | undefined;
  const windows = [l?.primary, l?.secondary].flatMap((w) => codexWindowOf(w) ?? []);
  const five = windows.find((w) => w.minutes === CODEX_FIVE_HOUR_MINUTES);
  const week = windows.find((w) => w.minutes === CODEX_WEEK_MINUTES);
  return five && week ? { provider: "codex", windows: { fiveHour: { percent: five.percent, resetsAt: five.resetsAt }, week: { percent: week.percent, resetsAt: week.resetsAt } }, at } : undefined;
};

/**
 * The reading a Codex session line holds: a `token_count` event, which carries the account's `rate_limits`
 * after each model reply. `codex exec --json` does not print them; the cross-review pass's command does,
 * from the session file in the sandbox (`CODEX_RATE_LIMITS_READOUT`), as its last stdout line.
 */
export const usageFromCodexEvent = (line: string, at: number): UsageReading | undefined => {
  if (!line.includes('"rate_limits"')) return undefined;
  let event: { type?: unknown; payload?: { type?: unknown; rate_limits?: unknown } | null } | null;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  return event?.type === "event_msg" && event.payload?.type === "token_count" ? usageFromRateLimits(event.payload.rate_limits, at) : undefined;
};

/**
 * What a cross-review pass runs after `codex exec` ends (sh, in the sandbox): the last `rate_limits` the
 * pass's session recorded, printed as one line so the raw stream - and with it the pass's `.jsonl` sidecar,
 * which `watchUsage` reads - carries it. Codex writes each session to `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`
 * inside the container, which is removed with the sandbox, and the kit runs it with `captureSessions: false` so
 * none is copied to the host's `~/.codex`: this is the only way out. The newest rollout is this pass's (the
 * sandbox is one ticket's, and its passes run one after another). The patterns match unescaped JSON only: a
 * file the reviewer read shows up in the rollout as an escaped string, which they do not match.
 */
export const CODEX_RATE_LIMITS_READOUT =
  'f=$(ls -t "${CODEX_HOME:-$HOME/.codex}"/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -n 1); ' +
  `[ -z "$f" ] || grep -F '"rate_limits":{' "$f" | grep -F '"type":"token_count"' | tail -n 1`;

/** One reader per provider: a line of the agent's raw stream to a reading, or undefined. A later provider adds one function here. */
const USAGE_READERS: Record<UsageProvider, (line: string, at: number) => UsageReading | undefined> = {
  claude: usageFromEvent,
  codex: usageFromCodexEvent,
};
export const USAGE_PROVIDERS = Object.keys(USAGE_READERS) as UsageProvider[];

/** A run record's `usage` entry, checked: the record is a file in a repository, so only well-formed numbers pass. `windows` and `at` are dropped together when either is wrong. */
export const readPlanUsage = (value: unknown): PlanUsage | undefined => {
  const u = value as { provider?: unknown; windows?: { fiveHour?: unknown; week?: unknown } | null; at?: unknown } | null | undefined;
  const provider = USAGE_PROVIDERS.find((p) => p === u?.provider);
  if (!provider) return undefined;
  const pct = (w: unknown) => {
    const x = w as { percent?: unknown; resetsAt?: unknown } | null | undefined;
    return typeof x?.percent === "number" && Number.isFinite(x.percent) && typeof x.resetsAt === "number" && Number.isFinite(x.resetsAt)
      ? { percent: Math.min(100, Math.max(0, Math.round(x.percent))), resetsAt: x.resetsAt }
      : undefined;
  };
  const fiveHour = pct(u?.windows?.fiveHour);
  const week = pct(u?.windows?.week);
  return fiveHour && week && typeof u?.at === "number" && Number.isFinite(u.at) ? { provider, windows: { fiveHour, week }, at: u.at } : { provider };
};

/** A run record's whole `usage`, checked: a list with one entry per provider, or the one object an older kit wrote. Entries that are no reading of a known provider are left out. */
export const readPlanUsages = (value: unknown): PlanUsage[] => (Array.isArray(value) ? value : [value]).flatMap((entry) => readPlanUsage(entry) ?? []);

// A Claude Code model is an id `claude-...` or one of the aliases Claude Code takes (`sonnet`, `opus[1m]`).
const CLAUDE_MODEL = /^(claude-|(sonnet|opus|opusplan|haiku|fable)(\[[\w.-]*\])?$)/i;
export const isClaudeModel = (model: string) => CLAUDE_MODEL.test(model);

/**
 * Whether the run shows the plan's usage: it spends a subscription (`CLAUDE_CODE_OAUTH_TOKEN`, and no API
 * key: `apiKey` is `projectApiKeySpend`'s answer, and a key is spent first even beside a token, which
 * bills API credits no plan describes) and at least one of the models implement, review and repair run
 * on is a Claude model.
 */
export const showsPlanUsage = ({ apiKey, oauthToken, models }: { apiKey: boolean; oauthToken: boolean; models: string[] }) =>
  !apiKey && oauthToken && models.some(isClaudeModel);

/** How Codex is signed in, from the text of its `auth.json` (never printed): `plan` for a ChatGPT sign-in, whose 5-hour and weekly limits the cross-review spends, `api key` for an API key, undefined for anything else or a file that cannot be read. */
export const codexSignIn = (text: string | undefined): "plan" | "api key" | undefined => {
  try {
    const auth = JSON.parse(text ?? "") as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } | null } | null;
    if (auth?.auth_mode === "chatgpt") return "plan";
    if (auth?.auth_mode === "apikey") return "api key";
    if (auth?.auth_mode != null) return undefined;
    // An older Codex wrote no mode: an API key is the key, a ChatGPT sign-in its tokens.
    if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) return "api key";
    return typeof auth?.tokens?.access_token === "string" && auth.tokens.access_token ? "plan" : undefined;
  } catch {
    return undefined;
  }
};

/** The text of the host's Codex login, the file the sandboxes get a read-only copy of (`sandboxMounts`), or undefined when there is none. */
export const readCodexAuth = (file = join(homedir(), ".codex", "auth.json")) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Whether the run shows Codex's usage: cross-review runs (`CROSS_REVIEW=1`), Codex is signed in with a
 * ChatGPT plan (`auth`, the text of `~/.codex/auth.json`) and no `CODEX_API_KEY` is in the sandboxes'
 * environment (`apiKey`), which Codex spends in place of its login. An API key has no plan to show.
 */
export const showsCodexUsage = ({ crossReview, apiKey, auth }: { crossReview: boolean; apiKey: boolean; auth: string | undefined }) =>
  crossReview && !apiKey && codexSignIn(auth) === "plan";

export type UsageWatch = {
  /** Reads what the logs gained since the last look and writes the record when a newer reading came (not more often than the interval, unless `final`). */
  poll(final?: boolean): void;
  /**
   * A ticket's agent pass has ended and the run counts its tokens itself (its result's own figure): what the logs showed of
   * the passes so far stops counting as live, and so does anything of them read later. Reads what the logs gained first.
   */
  settle(issue: string): void;
  /** One last look, written whatever the interval says, and no more after it. */
  stop(): void;
};

/**
 * One agent pass's tokens as its log shows them so far: Claude Code writes an assistant line per content block of a
 * message, each with the message's `usage`, so a message counts once, by its id (the latest usage it showed).
 */
type PassTokens = { seen: Map<string, Tokens>; total: Tokens };

type Tail = {
  ino: number; offset: number; decoder: StringDecoder; carry: string; skipping: boolean; mine: boolean;
  /** The ticket the file's pass belongs to; undefined when the watch counts no tokens or the name is no ticket's. */
  owner?: string;
  /** This run's passes in the file so far (each starts at a marker line), and how many of them `settle` handed to the run's own count. */
  pass: number;
  settled: number;
  tokens: PassTokens;
};

const NO_PASS = (): PassTokens => ({ seen: new Map(), total: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } });

/** The usage an assistant line of Claude's raw stream carries, with its message's id; undefined for any other line. */
export const tokensFromEvent = (line: string): { id?: string; tokens: Tokens } | undefined => {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return undefined;
  let event: { type?: unknown; message?: { id?: unknown; usage?: Record<string, unknown> | null } | null };
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const u = event?.type === "assistant" ? event.message?.usage : undefined;
  if (!u) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const id = event.message?.id;
  return { ...(typeof id === "string" ? { id } : {}), tokens: { input: n(u.input_tokens), cacheWrite: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens), output: n(u.output_tokens) } };
};

// A raw stream line is a whole tool result at most; one this long is not a rate-limit event.
const LONGEST_LINE = 8 << 20;
// A timer tick a few milliseconds early must not cost a whole interval of waiting.
const TICK_SLACK_MS = 1000;

/**
 * Watches this run's agent logs (`agent-issue-*.jsonl` in `logs`) for rate-limit events: every
 * `interval` it reads only what each file gained since the last look, and for each of `providers` the newest
 * reading - the latest-written file's last event - goes to `write` when one came, at most once an interval. A file counts
 * from the run's own marker line (`{"sandcastle":"run","run":<run>}`, which `agentLogging` writes
 * first) to the next one, so an earlier run's lines in the same file are not this run's reading. A failure
 * to read or to write is no reading: a full disk must not stop a run.
 */
export const watchUsage = ({
  logs,
  run,
  write,
  providers = USAGE_PROVIDERS,
  now = Date.now,
  interval = USAGE_INTERVAL_MS,
  finished = () => false,
  tokens,
}: {
  logs: string;
  run: string;
  write: (reading: UsageReading) => void;
  /** Whose readings the run shows; a line of another provider is not read. */
  providers?: UsageProvider[];
  now?: () => number;
  interval?: number;
  finished?: () => boolean;
  /**
   * The tokens each ticket's running pass has spent so far, from the same logs on the same tick: `owner` names the
   * ticket a log file belongs to (undefined for none), and `write` gets a ticket's live figure when it changed.
   */
  tokens?: { owner: (name: string) => string | undefined; write: (issue: string, live: Tokens) => void };
}): UsageWatch => {
  const tails = new Map<string, Tail>();
  let lastWrite = -Infinity;
  const pending = new Map<UsageProvider, UsageReading>();
  // Tickets whose live figure changed since it was last written.
  const changed = new Set<string>();
  let stopped = false;

  // What the ticket's passes that `settle` has not handed over spent so far.
  const live = (issue: string): Tokens => {
    const sum = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const tail of tails.values()) {
      if (tail.owner !== issue || tail.pass <= tail.settled) continue;
      sum.input += tail.tokens.total.input;
      sum.cacheWrite += tail.tokens.total.cacheWrite;
      sum.cacheRead += tail.tokens.total.cacheRead;
      sum.output += tail.tokens.total.output;
    }
    return sum;
  };

  const countTokens = (tail: Tail, line: string) => {
    const found = tokensFromEvent(line);
    if (!found) return;
    const { seen, total } = tail.tokens;
    const before = found.id === undefined ? undefined : seen.get(found.id);
    if (found.id !== undefined) seen.set(found.id, found.tokens);
    for (const key of Object.keys(total) as (keyof Tokens)[]) total[key] += found.tokens[key] - (before?.[key] ?? 0);
    changed.add(tail.owner!);
  };

  // The last reading of each provider in what `file` gained, and the file's modification time.
  const gained = (name: string, at: number): { mtime: number; readings: Map<UsageProvider, UsageReading> } | undefined => {
    const file = join(logs, name);
    const st = statSync(file);
    let tail = tails.get(name);
    // A file that shrank or changed identity is another file under the same name (archived, then started again).
    if (!tail || st.size < tail.offset || st.ino !== tail.ino) {
      tail = { ino: st.ino, offset: 0, decoder: new StringDecoder("utf8"), carry: "", skipping: false, mine: false, owner: tokens?.owner(name), pass: 0, settled: 0, tokens: NO_PASS() };
      tails.set(name, tail);
    }
    if (st.size === tail.offset) return undefined;
    const readings = new Map<UsageProvider, UsageReading>();
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(st.size - tail.offset, 1 << 20));
      while (tail.offset < st.size) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, st.size - tail.offset), tail.offset);
        if (n <= 0) break;
        tail.offset += n;
        let text = tail.decoder.write(buffer.subarray(0, n));
        if (tail.skipping) {
          const end = text.indexOf("\n");
          if (end < 0) continue;
          text = text.slice(end + 1);
          tail.skipping = false;
        }
        const lines = (tail.carry + text).split("\n");
        tail.carry = lines.pop()!;
        if (tail.carry.length > LONGEST_LINE) Object.assign(tail, { carry: "", skipping: true });
        for (const line of lines) {
          if (line.startsWith('{"sandcastle":"run"')) {
            try {
              tail.mine = (JSON.parse(line) as { run?: unknown }).run === run;
            } catch {
              tail.mine = false;
            }
            // Each of the run's markers starts a pass, which counts from nothing.
            if (tail.mine) Object.assign(tail, { pass: tail.pass + 1, tokens: NO_PASS() });
          } else if (tail.mine) {
            if (tail.owner !== undefined && tail.pass > tail.settled) countTokens(tail, line);
            for (const provider of providers) {
              const reading = USAGE_READERS[provider](line, at);
              if (reading) readings.set(provider, reading);
            }
          }
        }
      }
    } finally {
      closeSync(fd);
    }
    return readings.size ? { mtime: st.mtimeMs, readings } : undefined;
  };

  // What the logs gained since the last look: readings into `pending`, tickets with new tokens into `changed`.
  const scan = () => {
    try {
      const at = Math.floor(now() / 1000);
      // Oldest write first: where several files gained a reading, the last one written is the newest.
      const found = readdirSync(logs)
        .filter((name) => /^agent-issue-.+\.jsonl$/.test(name))
        .sort()
        .flatMap((name) => {
          try {
            const g = gained(name, at);
            return g ? [g] : [];
          } catch {
            return []; // archived or removed between the listing and the read
          }
        })
        .sort((a, b) => a.mtime - b.mtime);
      for (const g of found) for (const [provider, reading] of g.readings) pending.set(provider, reading);
    } catch {
      /* no logs directory yet */
    }
  };

  const poll = (final = false) => {
    if (stopped && !final) return;
    scan();
    if ((!pending.size && !changed.size) || (!final && now() - lastWrite < interval - TICK_SLACK_MS)) return;
    try {
      for (const [provider, reading] of pending) {
        write(reading);
        pending.delete(provider);
      }
      for (const issue of changed) {
        tokens?.write(issue, live(issue));
        changed.delete(issue);
      }
      lastWrite = now();
    } catch {
      /* the record could not be written: what is left is tried again at the next look */
    }
  };

  const settle = (issue: string) => {
    scan();
    for (const tail of tails.values()) if (tail.owner === issue) tail.settled = tail.pass;
    changed.delete(issue);
  };

  const timer = setInterval(() => (finished() ? stop() : poll()), interval);
  timer.unref();
  const stop = () => {
    if (stopped) return;
    poll(true);
    stopped = true;
    clearInterval(timer);
  };
  return { poll, stop, settle };
};

// ---------------------------------------------------------------------------
// `sandcastle usage`: the plan's usage between runs, read-only.
//
// The newest reading the run record (`logs/run.json`) or the history (`logs/history.jsonl`) holds is the
// answer while it is fresh (as young as the guard's own, `AGENT_READING_FRESH_SECONDS`): it costs no request.
// Otherwise one request goes to the endpoint with `usageToken`'s credential, as the guard's does - the
// endpoint is rate-limited, so never a second. Sandboxes that spend an API key have no plan to read.
// ---------------------------------------------------------------------------

/** The history lines looked at, newest last: a reading is as old as its run, so the tail is where a fresh one is. */
const HISTORY_TAIL = 50;

/**
 * The newest reading of each provider that the project's run record and history hold (`logs` is its
 * `.sandcastle/logs`); a file that is missing or does not parse holds none.
 */
export const recordedUsage = (logs: string): UsageReading[] => {
  const records: unknown[] = [];
  const parse = (text: string) => {
    try {
      records.push(JSON.parse(text));
    } catch {
      /* a half-written line is no record */
    }
  };
  try {
    parse(readFileSync(join(logs, "run.json"), "utf8"));
  } catch {
    /* no run yet */
  }
  try {
    readFileSync(join(logs, "history.jsonl"), "utf8").split("\n").filter(Boolean).slice(-HISTORY_TAIL).forEach(parse);
  } catch {
    /* no history yet */
  }
  const newest = new Map<UsageProvider, UsageReading>();
  for (const record of records) {
    for (const u of readPlanUsages((record as { usage?: unknown } | null)?.usage)) {
      if (!u.windows || u.at === undefined) continue;
      const held = newest.get(u.provider);
      if (!held || u.at > held.at) newest.set(u.provider, u as UsageReading);
    }
  }
  return [...newest.values()];
};

const ageWords = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

const recordedLine = (u: UsageReading, now: number) => {
  const window = (label: string, w: PlanWindow) =>
    w.resetsAt > now ? `${label} ${w.percent}% - resets ${resumeClock(w.resetsAt)}` : `${label} reset since (was ${w.percent}%)`;
  return `Plan usage (${u.provider === "codex" ? "Codex" : "Claude"}): ${window("5h", u.windows.fiveHour)} · ${window("week", u.windows.week)} (read ${ageWords(now - u.at)}, from the run record)`;
};

/**
 * What `sandcastle usage` prints, and whether it knows the plan's usage. `env` holds the sandboxes' Claude
 * credentials (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`); `recorded` is `recordedUsage`'s answer. An API key
 * is told first, whatever a record holds: it says nothing of what these sandboxes spend. A fresh Claude reading
 * is printed and nothing is asked; with none, the endpoint is asked once, and a failure says why and
 * is not retried. Codex's newest reading is added whenever the record has one, with its age.
 */
export const usageCommand = async ({
  env,
  recorded,
  readers = hostLoginReaders,
  now = Date.now,
}: {
  env: Record<string, string | undefined>;
  recorded: UsageReading[];
  readers?: LoginReaders;
  now?: () => number;
}): Promise<{ lines: string[]; known: boolean }> => {
  const seconds = Math.floor(now() / 1000);
  const credential = usageToken(env, process.platform, readers, now());
  if (credential?.source === "api key") {
    return { lines: ["Plan usage: the sandboxes spend ANTHROPIC_API_KEY (API credits, no plan), so there is no plan usage to read. Nothing was asked."], known: true };
  }
  const codex = recorded.filter((u) => u.provider === "codex").map((u) => recordedLine(u, seconds));
  const claude = recorded.find((u) => u.provider === "claude");
  if (claude && seconds - claude.at < AGENT_READING_FRESH_SECONDS) return { lines: [recordedLine(claude, seconds), ...codex], known: true };
  const stale = claude ? [`The newest reading on record is older than ${AGENT_READING_FRESH_SECONDS / 60} minutes: ${recordedLine(claude, seconds)}`] : [];
  // A stale reading is printed below the line, so the line must not say there is none.
  const none = claude ? "no fresh reading on record" : "no reading on record";
  const unknown = (why: string) => ({ lines: [`Plan usage: unknown (${none}, and ${why}).`, ...stale, ...codex], known: false });
  if (!credential) return unknown("the sandboxes have no CLAUDE_CODE_OAUTH_TOKEN to ask the plan's endpoint with");
  if (!("token" in credential)) return unknown("the Claude Code login has expired; any use of Claude Code on this machine refreshes it");
  const windows = await read(credential.token);
  if (!Array.isArray(windows)) return unknown(windows.why);
  return { lines: [`Plan usage: ${describe(windows)} (read just now, from the usage endpoint). Read for ${usageWhose(credential.source)}.`, ...codex], known: true };
};

// ---------------------------------------------------------------------------
// USAGE_PAUSE: wait out a plan window instead of running into it.
//
// With `USAGE_PAUSE=<percent>` (or `usagePause` in the project config) the run takes the soft pause of
// `sandcastle pause` itself when a window of a provider it uses reaches the threshold, or when an agent hits the
// limit anyway, and resumes by itself a minute after that window's reset. It reads the same agent readings the
// status view shows (`watchUsage`), so it needs no request and no credential. The pause is the control file
// `sandcastle pause` writes (src/detach.ts), with the cause in it: that is what lets a person's `sandcastle
// resume` end it early, and a person's `sandcastle pause` take it over so the timer never undoes it.
// ---------------------------------------------------------------------------

/** The pause threshold a USAGE_PAUSE value, else the project's `usagePause`, gives: undefined when neither is set (the pause is off); a value outside 1 to 100 is refused. */
export const parseUsagePause = (value: string | undefined, config?: unknown): number | undefined => {
  if (value) {
    const percent = Number(value);
    if (!(percent >= 1 && percent <= 100)) throw new OperatorError(`USAGE_PAUSE=${value} - expected 1 to 100.`);
    return percent;
  }
  if (config === undefined) return undefined;
  if (!(typeof config === "number" && config >= 1 && config <= 100)) throw new OperatorError(`usagePause=${JSON.stringify(config)} in the project config - expected 1 to 100.`);
  return config;
};

/** The start line for the pause: what it waits for, and what it cannot do when the run shows no plan usage (an API key, no Claude model). */
export const usagePauseLine = (percent: number, providers: UsageProvider[]) =>
  providers.length
    ? `Usage pause: at ${percent}%, resumes at the window's reset`
    : `Usage pause: at ${percent}%, but this run reads no plan usage (it needs a subscription token and a Claude model, or Codex cross-review on a ChatGPT plan), so it never pauses for it`;

/** What a usage pause says it waits for, in the status view's words: `weekly usage 95%`, `5-hour usage 93%`, with `Codex` first for Codex's windows. */
export const usagePauseWords = (p: Pick<UsagePaused, "provider" | "window" | "percent">) =>
  `${p.provider === "codex" ? "Codex " : ""}${p.window === "week" ? "weekly" : "5-hour"} usage ${p.percent}%`;

/** The time a usage pause resumes at: the time of day when it is today, else with the weekday (`Wed 06:01`), as the status view shows it. */
export const resumeClock = (seconds: number, now = new Date()) => {
  const at = new Date(seconds * 1000);
  const time = at.toTimeString().slice(0, 5);
  return at.toDateString() === now.toDateString() ? time : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.getDay()]} ${time}`;
};

/** The run resumes this long after a window's reset, so the window is surely open again when the next pass starts. */
export const USAGE_RESUME_GRACE_SECONDS = 60;

/** The windows of a provider's reading, and what `UsagePaused` records of one. */
type OpenWindow = { provider: UsageProvider; window: UsagePaused["window"]; percent: number; resetsAt: number };

/** The windows of these readings that have not reset yet: a stale reading says nothing of a window that has been open again since. */
const openWindows = (usage: PlanUsage[], now: number, provider?: UsageProvider): OpenWindow[] =>
  usage.flatMap((u) =>
    !u.windows || (provider && u.provider !== provider)
      ? []
      : (["fiveHour", "week"] as const).flatMap((window) => {
          const { percent, resetsAt } = u.windows![window];
          return resetsAt + USAGE_RESUME_GRACE_SECONDS > now ? [{ provider: u.provider, window, percent, resetsAt }] : [];
        }),
  );

const pausedFor = (w: OpenWindow, percent = w.percent): UsagePaused => ({ cause: "usage", provider: w.provider, window: w.window, percent, resumesAt: w.resetsAt + USAGE_RESUME_GRACE_SECONDS });

/** The window a pause would wait out, named so a person's resume can be remembered against it. */
const windowKey = (w: { provider: UsageProvider; window: UsagePaused["window"]; resetsAt: number }) => `${w.provider}:${w.window}:${w.resetsAt}`;

/**
 * The pause the readings call for at `threshold` percent: of the windows at or above it that have not reset
 * yet, the one that resets last - a run resumed at an earlier reset would only pause again - resumed a minute
 * after it. Undefined when no window is. `skip` leaves out the windows a person resumed through.
 */
export const usagePauseFor = (usage: PlanUsage[], threshold: number, now: number, skip: (w: OpenWindow) => boolean = () => false): UsagePaused | undefined => {
  const over = openWindows(usage, now).filter((w) => w.percent >= threshold && !skip(w));
  const last = over.reduce<OpenWindow | undefined>((a, b) => (a && a.resetsAt >= b.resetsAt ? a : b), undefined);
  return last && pausedFor(last);
};

/**
 * The pause for an agent that hit the limit: the open window nearest to spent (the later reset when two tie,
 * as both must reset), at 100% - the agent said so, whatever the last reading was. Undefined when no reading
 * names a window that is still to reset, so there is no telling when to resume. `provider`: whose agent it was.
 * `atLeast`: no window below it is taken for the one that was spent - a limit message with every window well
 * short of it is some other limit (one model's own cap, say), and days of waiting for the wrong window is worse than the old stop.
 */
export const usageLimitPauseFor = (usage: PlanUsage[], now: number, provider?: UsageProvider, atLeast = 0): UsagePaused | undefined => {
  const open = openWindows(usage, now, provider).filter((w) => w.percent >= atLeast);
  const worst = open.reduce<OpenWindow | undefined>((a, b) => (a && (a.percent > b.percent || (a.percent === b.percent && a.resetsAt >= b.resetsAt)) ? a : b), undefined);
  return worst && pausedFor(worst, 100);
};

/** A `UsagePaused` read from a record or a control file, or undefined when it is not one: those are files, so only well-formed values pass. */
export const readUsagePaused = (value: unknown): UsagePaused | undefined => {
  const u = value as Partial<Record<keyof UsagePaused, unknown>> | null | undefined;
  const provider = USAGE_PROVIDERS.find((p) => p === u?.provider);
  const window = u?.window === "fiveHour" || u?.window === "week" ? u.window : undefined;
  return u?.cause === "usage" && provider && window && typeof u.percent === "number" && Number.isFinite(u.percent) && typeof u.resumesAt === "number" && Number.isFinite(u.resumesAt)
    ? { cause: "usage", provider, window, percent: u.percent, resumesAt: u.resumesAt }
    : undefined;
};

/** The pause in force, as the control file says (`readPause`, `src/detach.ts`): a person's has no `usage`. */
export type StandingPause = { since: number; usage?: UsagePaused };

/** What the pause needs of the run's control file and clock; the run passes the real ones (`readPause` and `holdForUsage`, `src/detach.ts`), a test its own. */
export type UsagePausePorts = {
  /** The standing pause at `now` (seconds since the epoch); a usage pause past its time is none. */
  standing(now: number): StandingPause | undefined;
  /** Takes the pause, or - while the standing one is the run's own - moves it to this window when that resets later. A person's pause is left as it is. */
  hold(pause: UsagePaused, now: number): void;
  now?: () => number;
  /** The windows a person resumed the run through. A test gives its own; a run keeps one for the process (`RESUMED`). */
  resumed?: Set<string>;
};

// One for the process, not for a turn: each turn of a multi-turn run (autonomy 2, 3, drain) builds its own
// usage pause, and a person's early resume of a window must not be undone by the next turn's first reading.
const RESUMED = new Set<string>();

export type UsagePauseControl = {
  /** The pause source the schedule reads: the control file's, which also resumes the run once a usage pause's time has come. */
  source: { read(): StandingPause | undefined };
  /** A new reading arrived (`usage`: the newest of each provider): pauses the run when a window is at the threshold. Returns the pause asked for. */
  reading(usage: PlanUsage[]): UsagePaused | undefined;
  /** An agent of `provider` hit the limit: pauses the run until the window resets, true; false when no reading says when that is, and the limit stops the run as before. */
  limit(usage: PlanUsage[], provider?: UsageProvider): boolean;
};

/**
 * The run's usage pause at `threshold` percent. The control file is the one state: a person's `sandcastle
 * resume` removes it - a resume before its time, which the run remembers against the windows then at the
 * threshold, so the next reading does not undo it - and a person's `sandcastle pause` replaces it with one that
 * has no time to resume at, which nothing here ever lifts.
 */
export const createUsagePause = (threshold: number, ports: UsagePausePorts): UsagePauseControl => {
  const clock = ports.now ?? Date.now;
  const seconds = () => Math.floor(clock() / 1000);
  // The windows a person resumed the run through, and the usage pause last seen in force and the readings last known.
  const resumed = ports.resumed ?? RESUMED;
  let seen: UsagePaused | undefined;
  let latest: PlanUsage[] = [];
  // Looks at the control file and remembers what became of the usage pause. Read before every decision as well as by the
  // schedule's poll: a reading that came in the second after a person's resume must not write the pause again before it was noticed.
  const observe = (): StandingPause | undefined => {
    const now = seconds();
    const found = ports.standing(now);
    // A person who took the pause over leaves it as the run's own for this: it is still the usage pause that ends.
    if (found?.usage) seen = found.usage;
    else if (!found && seen) {
      // The pause is gone. Past its time it ended itself; before it, a person ended it.
      if (now < seen.resumesAt) {
        for (const w of openWindows(latest, now)) if (w.percent >= threshold) resumed.add(windowKey(w));
        resumed.add(windowKey({ ...seen, resetsAt: seen.resumesAt - USAGE_RESUME_GRACE_SECONDS }));
      }
      seen = undefined;
    }
    return found;
  };
  return {
    source: { read: observe },
    reading: (usage) => {
      observe();
      latest = usage;
      const now = seconds();
      const pause = usagePauseFor(usage, threshold, now, (w) => resumed.has(windowKey(w)));
      if (pause) ports.hold(pause, now);
      return pause;
    },
    limit: (usage, provider) => {
      const standing = observe();
      latest = usage;
      const now = seconds();
      // A person's pause: the ticket parks at its juncture and runs its pass again after the resume, and nothing here changes it.
      if (standing && !standing.usage) return true;
      // The run's own, which a limit that resets later than the standing window's moves on; or none yet. A window must be
      // near its end to be the one the agent hit: below the threshold the reading would have paused already, and below 90% the
      // limit is not the plan's windows' (`USAGE_RED`).
      const pause = usageLimitPauseFor(usage, now, provider, Math.min(threshold, USAGE_RED));
      if (pause) ports.hold(pause, now);
      return pause !== undefined || standing !== undefined;
    },
  };
};

/** What the run's pause handling does to the world, so a test drives it with fakes: the run record, the machine's keep-awake, the view and the log. */
export type PauseHandlingPorts = {
  /** Writes (or, with undefined, clears) the run record's `paused`. */
  record(paused: RunRecord["paused"]): void;
  /** One line to the run's log. */
  say(line: string): void;
  /** A ticket's name in the tracker's words. */
  ref(id: string): string;
  /** Lets the machine sleep: nothing is in flight. */
  releaseAwake(): void;
  /** Holds the machine awake again after a release; nothing when none was. */
  holdAwake(): Promise<void>;
  /** Redraws the status view. */
  refresh(): void;
  /** Milliseconds since the epoch. */
  now?(): number;
};

/**
 * The run's side of a pause, told by the scheduler: the `paused` and `resumed` changes write the record, say what the
 * run waits for (once, and again when that changes) and release or re-take keep-awake. `end` is the run's close with its
 * last ticket landed while paused: not paused any more, and awake for the verify and the summary. `waitOutPause` is
 * an attempt's wait, before the guard decides, for a pause the latest reading has just asked for.
 */
export const createPauseHandling = (ports: PauseHandlingPorts) => {
  // Said once per pause: the first time the scheduler tells it, and again when what it waits for changes.
  let said: string | undefined;
  // What the run is paused for when it took the pause itself, to say how it ended.
  let forUsage: UsagePaused | undefined;
  const now = ports.now ?? Date.now;
  const clockOf = (seconds: number) => new Date(seconds * 1000).toTimeString().slice(0, 5);
  return {
    /** The `paused`, `resumed` and `pause stopped` changes; any other is not this handler's. */
    told(c: Change<unknown, unknown>): void {
      if (c.kind === "paused") {
        // The tickets still finishing; once none is, the machine may sleep (the demand is 0 by then too).
        ports.record({ since: c.since, finishing: c.finishing, ...c.usage });
        const finishing = c.finishing.length ? `finishing ${c.finishing.map(ports.ref).join(", ")}` : "nothing is in flight";
        const cause = c.usage ? JSON.stringify(c.usage) : "person";
        if (said === undefined) {
          ports.say(
            c.usage
              ? `[${clockOf(c.since)}] paused for plan usage (${usagePauseWords(c.usage)}): no new ticket or agent pass starts; ${finishing}. It resumes by itself at ${resumeClock(c.usage.resumesAt)}, a minute after the window resets, or at \`sandcastle resume\`.`
              : `[${clockOf(c.since)}] paused by \`sandcastle pause\`: no new ticket or agent pass starts; ${finishing}.`,
          );
        } else if (said !== cause) {
          ports.say(
            c.usage
              ? `The pause now waits for ${usagePauseWords(c.usage)}: it resumes at ${resumeClock(c.usage.resumesAt)}.`
              : "The pause is a person's now (`sandcastle pause`): it stays until `sandcastle resume`.",
          );
        }
        said = cause;
        forUsage = c.usage;
        if (!c.finishing.length) ports.releaseAwake();
        ports.refresh();
      } else if (c.kind === "resumed") {
        ports.record(undefined);
        ports.say(
          forUsage && now() / 1000 >= forUsage.resumesAt
            ? `Resumed: the plan's usage window has reset; each paused ticket goes on from its next phase.`
            : "Resumed: each paused ticket goes on from its next phase.",
        );
        said = undefined;
        forUsage = undefined;
        void ports.holdAwake();
        ports.refresh();
      } else if (c.kind === "pause stopped") {
        // A stop ended the pause: tickets in flight finish, and the Herdr sidebar and tab bar read this record meanwhile.
        ports.record(undefined);
        said = undefined;
        forUsage = undefined;
        void ports.holdAwake();
        ports.refresh();
      }
    },
    /** The run's close: a pause still told is cleared and the machine held awake. */
    async end(): Promise<void> {
      if (said === undefined) return;
      ports.record(undefined);
      said = undefined;
      await ports.holdAwake();
    },
    /**
     * While the run is paused for plan usage, the attempt reaches its first juncture and waits there for the resume. A pause the
     * latest reading has just asked for is read before the guard decides: the guard's stop is for a run that is not waiting out
     * the window (it would otherwise win a race of a second against the schedule's own poll).
     */
    async waitOutPause(usageGuard: boolean, paused: () => boolean, juncture: (phase: string, park: { suspend(): Promise<void>; resume(): Promise<void> }) => Promise<void>): Promise<void> {
      while (usageGuard && paused()) await juncture("start", { suspend: async () => {}, resume: async () => {} });
    },
  };
};
