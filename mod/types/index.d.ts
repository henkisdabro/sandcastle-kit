/** What the band above the prompt draws from (run-state.ts, `Summary`); null while no run is live. */
export type View = { name: string; stage: string; counts: number[]; tokens: string } | null;

declare module "claude-code" {
  interface PluginState {
    /**
     * `castle`: the frame of the castle the band draws, an index into run-state.ts's `CASTLE_FRAMES`.
     * `mark`: the idle mark's line the band draws between runs (idle.ts's `markText`), null for none.
     */
    sandcastle: { view: View; castle: number; mark: string | null };
  }
}
