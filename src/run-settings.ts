// The run settings (CONTEXT.md): what a run is told at its start that shapes what it does or
// spends. One pure resolver reads the environment, the project config and the personal machine
// settings, so `sandcastle run` and `sandcastle status` cannot disagree about the next run; each
// later setting is one more field here. The precedence never changes: the environment beats the
// project config, which beats the default.
import type { RunSettings } from "../mod/hooks/run-record.ts";
import { autonomyLevel, type Level, turnCap } from "./autonomy.ts";
import { DEFAULT_CONCURRENCY } from "./config.ts";
import { pipelineWorkers } from "./landing.ts";
import { poolLimit, wholeNumber } from "./pool.ts";

export type SettingsSources = {
  env: Record<string, string | undefined>;
  /** The project's `.sandcastle/config.ts`, as far as settings are concerned. */
  project: { autonomy?: unknown; concurrency?: unknown; repair?: { attempts?: unknown } };
  /** The personal `config.json`: the machine-wide sandbox cap that clamps concurrency. */
  machine: Record<string, unknown>;
};

/**
 * What a run resolves once, at its start. `concurrency.asked` is the most tickets the run wants at
 * once (`--concurrency`, `CONCURRENCY`, the config or the default); `effective` is that after the
 * machine-wide sandbox cap, before the ticket count (a short queue is not a clamp).
 */
export type ResolvedSettings = { autonomy: Level; repair: number; concurrency: { asked: number; effective: number } };

export const resolveSettings = ({ env, project, machine }: SettingsSources): ResolvedSettings => {
  const pool = poolLimit("sandboxes", env, machine);
  const asked = wholeNumber("CONCURRENCY", env.CONCURRENCY ?? project.concurrency ?? DEFAULT_CONCURRENCY, 1);
  return {
    autonomy: autonomyLevel(env.AUTONOMY_LEVEL, project.autonomy),
    // The attempts a ticket gets after a red gate; 0 turns repair off. Only the project config sets it.
    repair: wholeNumber("repair.attempts", project.repair?.attempts ?? 1, 0),
    // A dry run lands nothing, so it keeps no sandbox slot for landing.
    concurrency: { asked, effective: Math.min(pipelineWorkers(asked, Infinity, pool, env.DRY_RUN !== "1"), pool) },
  };
};

/** The settings group of one turn's run record: the run's settings, this turn's number and the level's cap. */
export const settingsGroup = (settings: ResolvedSettings, turn: number): RunSettings => {
  const cap = turnCap(settings.autonomy);
  return {
    autonomy: settings.autonomy,
    turn,
    ...(cap === undefined ? {} : { cap }),
    repair: settings.repair,
    concurrency: settings.concurrency.effective,
    asked: settings.concurrency.asked,
  };
};
