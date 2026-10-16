// The run settings (GLOSSARY.md): what a run is told at its start that shapes what it does or
// spends. One pure resolver reads the environment, the project config and the personal machine
// settings, so `sandcastle run` and `sandcastle status` cannot disagree about the next run; each
// later setting is one more field here. The precedence never changes: the environment beats the
// project's `.sandcastle/config.local.json` (a clone's own, untracked), which beats `.sandcastle/config.ts`,
// which beats the default; `loadProject` merges the two files, so `project` below is the merged one.
import type { RunSettings } from "../mod/hooks/run-record.ts";
import { type CrossReviewSetting, crossReviewSetting } from "./agents.ts";
import { autonomyLevel, type Level, turnCap } from "./autonomy.ts";
import { DEFAULT_CONCURRENCY } from "./config.ts";
import { parseLoadPause } from "./load-pause.ts";
import { pipelineWorkers } from "./landing.ts";
import { poolLimit, wholeNumber } from "./pool.ts";
import { parseUsagePause, parseUsageStop } from "./usage.ts";

export type SettingsSources = {
  env: Record<string, string | undefined>;
  /** The project's `.sandcastle/config.ts` with `.sandcastle/config.local.json` merged over it, as far as settings are concerned. */
  project: { autonomy?: unknown; concurrency?: unknown; repair?: { attempts?: unknown }; usagePause?: unknown; loadPause?: unknown; keepWarm?: unknown; localKeys?: string[] };
  /** The personal `config.json`: the machine-wide sandbox cap that clamps concurrency. */
  machine: Record<string, unknown>;
  /** Whether the credentials files put `ANTHROPIC_API_KEY` in the sandboxes (`projectApiKeySpend`); read by the caller, so this stays pure. */
  apiKey?: boolean;
};

/**
 * What a run resolves once, at its start. `concurrency.asked` is the most tickets the run wants at
 * once (`--concurrency`, `CONCURRENCY`, the config or the default); `effective` is that after the
 * machine-wide sandbox cap, before the ticket count (a short queue is not a clamp).
 */
export type ResolvedSettings = {
  autonomy: Level;
  crossReview: CrossReviewSetting;
  repair: number;
  concurrency: { asked: number; effective: number };
  /** Whether the usage guard was asked for (`USAGE_CHECK=1`). */
  usageGuard: boolean;
  /** The guard's stop threshold in percent; only when it is on. */
  usageStop?: number;
  /** The plan usage in percent at which the run pauses itself and resumes after the window's reset (`USAGE_PAUSE`, or the project's `usagePause`); absent when it is off. In the settings group too, so a summary never reads as if nothing watched the plan. */
  usagePause?: number;
  /** The machine-wide CPU pressure in percent (`some` `avg60`) at or over which the run holds each gate pass (`LOAD_PAUSE`, or the project's `loadPause`, else 60); absent when it is off. In the settings group too. */
  loadPause?: number;
  /** Whether the session that started the run keeps its prompt cache warm while the run is live: false when the machine settings say `false`, else the project's value, else true. */
  keepWarm: boolean;
  /** True when the sandboxes spend an API key, billing API credits; absent otherwise. */
  apiKey?: true;
  /** The dotted keys `.sandcastle/config.local.json` set whose value the run took from the file, not from the environment; absent when there are none. */
  local?: string[];
};

/** The environment variable that overrides each setting key, by the same test its parser uses: a key the environment set is not the file's. */
const ENV_SETS: Record<string, (env: Record<string, string | undefined>) => boolean> = {
  autonomy: (env) => !!env.AUTONOMY_LEVEL?.trim(),
  concurrency: (env) => env.CONCURRENCY !== undefined,
  usagePause: (env) => !!env.USAGE_PAUSE,
  "implement.model": (env) => env.IMPL_MODEL !== undefined,
  "implement.effort": (env) => env.IMPL_EFFORT !== undefined,
  "review.model": (env) => env.REVIEW_MODEL !== undefined,
  "review.effort": (env) => env.REVIEW_EFFORT !== undefined,
};

export const resolveSettings = ({ env, project, machine, apiKey = false }: SettingsSources): ResolvedSettings => {
  const pool = poolLimit("sandboxes", env, machine);
  const asked = wholeNumber("CONCURRENCY", env.CONCURRENCY ?? project.concurrency ?? DEFAULT_CONCURRENCY, 1);
  const usageGuard = env.USAGE_CHECK === "1";
  const usagePause = parseUsagePause(env.USAGE_PAUSE, project.usagePause);
  const loadPause = parseLoadPause(env.LOAD_PAUSE, project.loadPause);
  const local = (project.localKeys ?? []).filter((key) => !ENV_SETS[key]?.(env));
  return {
    autonomy: autonomyLevel(env.AUTONOMY_LEVEL, project.autonomy),
    crossReview: crossReviewSetting(env),
    // The attempts a ticket gets after a red gate; 0 turns repair off. Only the project config sets it.
    repair: wholeNumber("repair.attempts", project.repair?.attempts ?? 1, 0),
    // A dry run lands nothing, so it keeps no sandbox slot for landing.
    concurrency: { asked, effective: Math.min(pipelineWorkers(asked, Infinity, pool, env.DRY_RUN !== "1"), pool) },
    usageGuard,
    ...(usageGuard ? { usageStop: parseUsageStop(env.USAGE_STOP) } : {}),
    ...(usagePause === undefined ? {} : { usagePause }),
    ...(loadPause === undefined ? {} : { loadPause }),
    // The machine's `false` is a person's off switch for every project, so it beats the project's `true`.
    keepWarm: machine.keepWarm === false ? false : project.keepWarm !== false,
    ...(apiKey ? { apiKey: true as const } : {}),
    ...(local.length ? { local } : {}),
  };
};

/**
 * The settings group of one turn's run record: the run's settings, this turn's number and the
 * level's cap. A follow-on turn for tickets queued while the run was live goes past the cap, and
 * "turn 3/2" read as a fault, so such a turn records no cap. `noReading` is the guard's reading as
 * a fact beside its setting, not part of it.
 */
export const settingsGroup = (settings: ResolvedSettings, turn: number, noReading = false): RunSettings => {
  const cap = turnCap(settings.autonomy);
  const cross = settings.crossReview;
  return {
    autonomy: settings.autonomy,
    turn,
    ...(cap === undefined || turn > cap ? {} : { cap }),
    repair: settings.repair,
    concurrency: settings.concurrency.effective,
    asked: settings.concurrency.asked,
    crossReview: cross.on,
    ...(cross.on ? { crossReviewModel: cross.model, crossReviewEffort: cross.effort } : {}),
    usageGuard: settings.usageGuard,
    ...(settings.usageStop === undefined ? {} : { usageStop: settings.usageStop }),
    ...(settings.usageGuard && noReading ? { usageReading: "unavailable" as const } : {}),
    ...(settings.usagePause === undefined ? {} : { usagePause: settings.usagePause }),
    ...(settings.loadPause === undefined ? {} : { loadPause: settings.loadPause }),
    // Always, true or false, so a reader never has to guess a default.
    keepWarm: settings.keepWarm,
    // Only when it does: a subscription run's record and view stay as they were.
    ...(settings.apiKey ? { apiKey: true } : {}),
    // Only when the clone's local file set a value the run took: a project without the file records nothing new.
    ...(settings.local?.length ? { local: settings.local } : {}),
  };
};
