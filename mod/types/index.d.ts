/** What the band above the prompt draws from (run-state.ts, `Summary`); null while no run is live. */
export type View = { name: string; stage: string; counts: number[]; tokens: string } | null;

/** What the cache refresh remembers (keep-warm.ts's `Warmth`; this contract is self-contained, so it is written out). */
export type Warmth = {
  run?: string;
  last?: { at: number; cacheRead: number; contextTokens: number };
  misses: number;
  turnEnd?: number;
};

declare module "claude-code" {
  interface PluginState {
    /**
     * `castle`: the frame of the castle the band draws, an index into run-state.ts's `CASTLE_FRAMES`.
     * `mark`: the idle mark's line the band draws between runs (idle.ts's `markText`), null for none.
     * `warm`: the cache refresh's row under the castle (keep-warm.ts's `band`), null for none.
     * `warmth`: what the refresh remembers across a reload (keep-warm.ts's `Warmth`).
     */
    sandcastle: { view: View; castle: number; mark: string | null; warm: string | null; warmth: Warmth };
  }
}
