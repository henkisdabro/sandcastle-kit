// Which Claude Code and Codex the sandbox image installs. Resolved on the host when the image is
// ensured and made part of the image's identity (src/sandbox.ts), so a run that crosses a release
// rebuilds once and every sandbox of a run has the same version. The Dockerfile's `ARG` defaults
// are only the offline fallback.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OperatorError } from "./errors.ts";
import { KIT } from "./sandbox.ts";

export type Versions = {
  claude: string;
  codex: string;
  /** The channel Claude Code followed (`latest`, `stable`), or `pinned` for an exact version. */
  channel: string;
  /**
   * `network`: resolved, or given as a version, or served from a cache younger than six hours.
   * `cache`: a fetch failed and an older cached value was used. `fallback`: a fetch failed with no
   * cache, so the Dockerfile's `ARG` default was used.
   */
  source: "network" | "cache" | "fallback";
};

export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string>; json(): Promise<unknown> }>;

export const VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
export const CHANNEL = /^(latest|stable)$/;
/** What `claudeCode` and `CLAUDE_CODE_VERSION` accept: a channel name or an exact version. */
export const isClaudeSetting = (s: unknown): s is string => typeof s === "string" && (CHANNEL.test(s) || VERSION.test(s));

const CACHE_TTL_MS = 6 * 3_600_000;
const RELEASES = "https://downloads.claude.ai/claude-code-releases";
// The full packument: only it carries each version's publish time (`time`), and it is large (every
// platform build is a version), hence the longer timeout and the six-hour cache.
const CODEX_PACKUMENT = "https://registry.npmjs.org/@openai/codex";
/** A Codex release is not used until it is this old, as the project's own pnpm config waits on dependencies. */
const CODEX_COOLDOWN_MS = 72 * 3_600_000;

type Entry = { version: string; at: number };
type Cache = { claude?: Record<string, Entry>; codex?: Entry };

// Read at call time: a test (or a user) may move XDG_CACHE_HOME after this module loads.
const cacheFile = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sandcastle-kit", "versions.json");

const readCache = (): Cache => {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeCache = (cache: Cache) => {
  // A cache that cannot be written only costs the next call a fetch.
  try {
    const file = cacheFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(cache, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
  } catch {
    /* ignore */
  }
};

/** The `ARG` defaults of docker/agents.Dockerfile: what an offline machine with no cache builds. */
const dockerfileDefaults = () => {
  const text = readFileSync(join(KIT, "docker/agents.Dockerfile"), "utf8");
  const arg = (name: string) => {
    const v = text.match(new RegExp(`^ARG ${name}=(\\S+)\\s*$`, "m"))?.[1];
    if (!v || !VERSION.test(v)) throw new Error(`docker/agents.Dockerfile has no ARG ${name}=<x.y.z> default`);
    return v;
  };
  return { claude: arg("CLAUDE_CODE_VERSION"), codex: arg("CODEX_VERSION") };
};

const get = async (fetcher: Fetcher, url: string, timeoutMs = 5_000) => {
  const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP error`);
  return res;
};

const valid = (v: unknown): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!VERSION.test(s)) throw new Error(`not a version: ${JSON.stringify(String(v).slice(0, 40))}`);
  return s;
};

/** Whether plain `x.y.z` version `a` is above `b`, in semver order. */
const above = (a: number[], b: number[]) => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] > b[i];
};

/**
 * The newest plain `x.y.z` in an npm packument whose `time` entry is at least the cooldown old,
 * still published, not deprecated and not above `dist-tags.latest`. Pre-releases and the platform
 * builds (`0.160.0-linux-x64`) are not plain, so they never count.
 * Throws when there is none, which resolves like any failed fetch.
 */
const codexAfterCooldown = (packument: unknown, now: number): string => {
  const doc = packument as { time?: Record<string, unknown>; versions?: Record<string, unknown>; "dist-tags"?: Record<string, unknown> } | null;
  const time = doc?.time;
  if (!time || typeof time !== "object") throw new Error("npm packument has no publish times");
  const versions = doc?.versions && typeof doc.versions === "object" ? doc.versions : {};
  // A release deprecated for being broken can still be the newest past the cooldown, an
  // unpublished one keeps its `time` entry (and would fail every image build), and `latest`
  // moved back after a bad release marks everything above it as not to be used.
  const latestTag = doc?.["dist-tags"]?.latest;
  const ceiling = typeof latestTag === "string" && /^\d+\.\d+\.\d+$/.test(latestTag) ? latestTag.split(".").map(Number) : undefined;
  let best: number[] | undefined;
  for (const [version, published] of Object.entries(time)) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const manifest = versions[version];
    if (!manifest || typeof manifest !== "object" || (manifest as { deprecated?: unknown }).deprecated) continue;
    const at = typeof published === "string" ? Date.parse(published) : NaN;
    if (!(now - at >= CODEX_COOLDOWN_MS)) continue;
    const parts = version.split(".").map(Number);
    if (ceiling && above(parts, ceiling)) continue;
    // Semver order, not publish order: a patch release of an older line can be published later.
    if (!best || above(parts, best)) best = parts;
  }
  if (!best) throw new Error("no Codex release is past the cooldown");
  return best.join(".");
};

type Part = { version: string; from: Versions["source"] };

/** One component: a fresh cache entry, else the fetch, else any cache entry, else the default. */
const resolvePart = async (
  fresh: Entry | undefined,
  stale: Entry | undefined,
  fetchIt: () => Promise<string>,
  save: (e: Entry) => void,
  fallback: string,
  failed: (from: "cache" | "the Dockerfile's default", version: string) => void,
): Promise<Part> => {
  if (fresh) return { version: fresh.version, from: "network" };
  try {
    const version = await fetchIt();
    save({ version, at: Date.now() });
    return { version, from: "network" };
  } catch {
    const entry = stale && VERSION.test(stale.version) ? stale : undefined;
    failed(entry ? "cache" : "the Dockerfile's default", entry?.version ?? fallback);
    return entry ? { version: entry.version, from: "cache" } : { version: fallback, from: "fallback" };
  }
};

/**
 * Claude Code from `claudeCode` in the project config (default `stable`; `CLAUDE_CODE_VERSION`
 * overrides it), Codex from `CODEX_VERSION` or the newest plain release on npm at least 72 hours old. Never throws for a network failure:
 * the cached value is used whatever its age, then the Dockerfile's defaults. A bad setting is an
 * OperatorError. `log` gets the one line printed when a value did not come from the network.
 */
export const resolveVersions = async (
  project: { claudeCode?: string },
  fetcher: Fetcher = fetch as unknown as Fetcher,
  log: (line: string) => void = console.log,
): Promise<Versions> => {
  const fromEnv = process.env.CLAUDE_CODE_VERSION || undefined;
  // The stable channel trails latest and skips releases that regressed; a sandbox runs unattended.
  const setting = fromEnv ?? project.claudeCode ?? "stable";
  if (!isClaudeSetting(setting)) {
    throw new OperatorError(
      fromEnv
        ? `CLAUDE_CODE_VERSION must be "latest", "stable" or a version like 2.1.285, not ${JSON.stringify(setting)}.`
        : `.sandcastle/config.ts: claudeCode must be "latest", "stable" or a version like 2.1.285, not ${JSON.stringify(setting)}.`,
    );
  }
  const codexEnv = process.env.CODEX_VERSION || undefined;
  if (codexEnv && !VERSION.test(codexEnv)) throw new OperatorError(`CODEX_VERSION must be a version like 0.159.2, not ${JSON.stringify(codexEnv)}.`);

  const cache = readCache();
  const defaults = dockerfileDefaults();
  const isFresh = (e: Entry | undefined) => (e && VERSION.test(e.version) && Date.now() - e.at >= 0 && Date.now() - e.at < CACHE_TTL_MS ? e : undefined);
  const parts: Part[] = [];

  let claude: Part;
  if (VERSION.test(setting)) claude = { version: setting, from: "network" };
  else {
    const entry = cache.claude?.[setting];
    claude = await resolvePart(
      isFresh(entry),
      entry,
      async () => valid(await (await get(fetcher, `${RELEASES}/${setting}`)).text()),
      (e) => writeCache({ ...cache, claude: { ...cache.claude, [setting]: e } }),
      defaults.claude,
      (from, v) => log(`Claude Code: could not reach the release channel - using ${v} from ${from}.`),
    );
  }
  parts.push(claude);

  let codex: Part;
  if (codexEnv) codex = { version: codexEnv, from: "network" };
  else {
    codex = await resolvePart(
      isFresh(cache.codex),
      cache.codex,
      async () => valid(codexAfterCooldown(await (await get(fetcher, CODEX_PACKUMENT, 30_000)).json(), Date.now())),
      // Re-read: the Claude entry above may have been written since `cache` was read.
      (e) => writeCache({ ...readCache(), codex: e }),
      defaults.codex,
      (from, v) => log(`Codex: could not reach the npm registry - using ${v} from ${from}.`),
    );
  }
  parts.push(codex);

  const source = parts.some((p) => p.from === "fallback") ? "fallback" : parts.some((p) => p.from === "cache") ? "cache" : "network";
  return { claude: claude.version, codex: codex.version, channel: VERSION.test(setting) ? "pinned" : setting, source };
};

/** The line a run and `sandcastle build` print; a run gives the kit version too (`build` does not). */
export const versionsLine = (v: Versions, kit?: string) =>
  `${kit ? `sandcastle-kit ${kit} · ` : ""}Claude Code ${v.claude} (${v.channel}) · Codex ${v.codex}`;
