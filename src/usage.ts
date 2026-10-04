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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** Why no further issue should start, or undefined to carry on. */
export const usageStop = async (env: Record<string, string>, readers: LoginReaders = hostLoginReaders) => {
  if (!USAGE_CHECK) return undefined;
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
