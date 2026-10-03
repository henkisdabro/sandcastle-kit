// The run settings (CONTEXT.md): what a run is told at its start that shapes what it does or
// spends. One pure resolver reads the environment, the project config and the personal machine
// settings, so `sandcastle run` and `sandcastle status` cannot disagree about the next run; each
// later setting is one more field here. The precedence never changes: the environment beats the
// project config, which beats the default.
import type { RunSettings } from "../mod/hooks/run-record.ts";
import { autonomyLevel, type Level, turnCap } from "./autonomy.ts";

export type SettingsSources = {
  env: Record<string, string | undefined>;
  /** The project's `.sandcastle/config.ts`, as far as settings are concerned. */
  project: { autonomy?: unknown };
  /** The personal `config.json`; no setting reads it yet. */
  machine: Record<string, unknown>;
};

/** What a run resolves once, at its start. */
export type ResolvedSettings = { autonomy: Level };

export const resolveSettings = ({ env, project }: SettingsSources): ResolvedSettings => ({
  autonomy: autonomyLevel(env.AUTONOMY_LEVEL, project.autonomy),
});

/** The settings group of one turn's run record: the run's settings, this turn's number and the level's cap. */
export const settingsGroup = (settings: ResolvedSettings, turn: number): RunSettings => {
  const cap = turnCap(settings.autonomy);
  return { autonomy: settings.autonomy, turn, ...(cap === undefined ? {} : { cap }) };
};
