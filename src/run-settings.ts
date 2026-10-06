// The run settings (GLOSSARY.md): what a run is told at its start that shapes what it does or
// spends. One pure resolver reads the environment, the project config and the personal machine
// settings, so `sandcastle run` and `sandcastle status` cannot disagree about the next run; each
// later setting is one more field here. The precedence never changes: the environment beats the
// project config, which beats the default.
import type { RunSettings } from "../mod/hooks/run-record.ts";
import { type CrossReviewSetting, crossReviewSetting } from "./agents.ts";
import { autonomyLevel, type Level, turnCap } from "./autonomy.ts";
import { DEFAULT_CONCURRENCY } from "./config.ts";
import { pipelineWorkers } from "./landing.ts";
import { poolLimit, wholeNumber } from "./pool.ts";
import { parseUsagePause, parseUsageStop } from "./usage.ts";

export type SettingsSources = {
  env: Record<string, string | undefined>;
  /** The project's `.sandcastle/config.ts`, as far as settings are concerned. */
  project: { autonomy?: unknown; concurrency?: unknown; repair?: { attempts?: unknown }; usagePause?: unknown };
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
  /** The plan usage in percent at which the run pauses itself and resumes after the window's reset (`USAGE_PAUSE`, or the project's `usagePause`); absent when it is off. Not in the run record's settings group: the record says when a run is paused for it. */
  usagePause?: number;
  /** True when the sandboxes spend an API key, billing API credits; absent otherwise. */
  apiKey?: true;
};

export const resolveSettings = ({ env, project, machine, apiKey = false }: SettingsSources): ResolvedSettings => {
  const pool = poolLimit("sandboxes", env, machine);
  const asked = wholeNumber("CONCURRENCY", env.CONCURRENCY ?? project.concurrency ?? DEFAULT_CONCURRENCY, 1);
  const usageGuard = env.USAGE_CHECK === "1";
  const usagePause = parseUsagePause(env.USAGE_PAUSE, project.usagePause);
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
    ...(apiKey ? { apiKey: true as const } : {}),
  };
};

/**
 * The settings group of one turn's run record: the run's settings, this turn's number and the
 * level's cap. `noReading` is the guard's reading as a fact beside its setting, not part of it.
 */
export const settingsGroup = (settings: ResolvedSettings, turn: number, noReading = false): RunSettings => {
  const cap = turnCap(settings.autonomy);
  const cross = settings.crossReview;
  return {
    autonomy: settings.autonomy,
    turn,
    ...(cap === undefined ? {} : { cap }),
    repair: settings.repair,
    concurrency: settings.concurrency.effective,
    asked: settings.concurrency.asked,
    crossReview: cross.on,
    ...(cross.on ? { crossReviewModel: cross.model, crossReviewEffort: cross.effort } : {}),
    usageGuard: settings.usageGuard,
    ...(settings.usageStop === undefined ? {} : { usageStop: settings.usageStop }),
    ...(settings.usageGuard && noReading ? { usageReading: "unavailable" as const } : {}),
    // Only when it does: a subscription run's record and view stay as they were.
    ...(settings.apiKey ? { apiKey: true } : {}),
  };
};
