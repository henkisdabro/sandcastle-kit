// The run settings (CONTEXT.md): what a run is told at its start that shapes what it does or
// spends. One pure resolver reads the environment, the project config and the personal machine
// settings, so `sandcastle run` and `sandcastle status` cannot disagree about the next run; each
// later setting is one more field here. The precedence never changes: the environment beats the
// project config, which beats the default.
import type { RunSettings } from "../mod/hooks/run-record.ts";
import { type CrossReviewSetting, crossReviewSetting } from "./agents.ts";
import { autonomyLevel, type Level, turnCap } from "./autonomy.ts";
import { parseUsageStop } from "./usage.ts";

export type SettingsSources = {
  env: Record<string, string | undefined>;
  /** The project's `.sandcastle/config.ts`, as far as settings are concerned. */
  project: { autonomy?: unknown };
  /** The personal `config.json`; no setting reads it yet. */
  machine: Record<string, unknown>;
};

/** What a run resolves once, at its start. */
export type ResolvedSettings = {
  autonomy: Level;
  crossReview: CrossReviewSetting;
  /** Whether the usage guard was asked for (`USAGE_CHECK=1`). */
  usageGuard: boolean;
  /** The guard's stop threshold in percent; only when it is on. */
  usageStop?: number;
};

export const resolveSettings = ({ env, project }: SettingsSources): ResolvedSettings => {
  const usageGuard = env.USAGE_CHECK === "1";
  return {
    autonomy: autonomyLevel(env.AUTONOMY_LEVEL, project.autonomy),
    crossReview: crossReviewSetting(env),
    usageGuard,
    ...(usageGuard ? { usageStop: parseUsageStop(env.USAGE_STOP) } : {}),
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
    crossReview: cross.on,
    ...(cross.on ? { crossReviewModel: cross.model, crossReviewEffort: cross.effort } : {}),
    usageGuard: settings.usageGuard,
    ...(settings.usageStop === undefined ? {} : { usageStop: settings.usageStop }),
    ...(settings.usageGuard && noReading ? { usageReading: "unavailable" as const } : {}),
  };
};
