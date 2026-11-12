// How the closing summary and the drain's end line word a time, a span and a token count. Pure and light, with no
// import the runtime keeps: src/autonomy.ts uses them, and the status view imports that (through src/status-rows.ts),
// so taking them from src/run.ts would load the run's modules into every status view.

import type { Tokens } from "./run.ts";

/** Local `HH:MM` of an ISO time: the closing summary's and the drain line's one way to say a time. */
export const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

/** A length of time in whole minutes (`20m`, `2h 22m`), as the closing summary and the drain line say it. */
export const spanOf = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/** A token count in three figures at most: `950`, `406k`, `52.8M`. */
export const k = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/** The status view's run line has no room for the cached share. */
export const tokenBrief = (t: Tokens) => `${k(t.input + t.cacheWrite + t.cacheRead)} in / ${k(t.output)} out`;
