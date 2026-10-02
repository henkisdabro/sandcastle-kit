/** What the band above the prompt draws from (run-state.ts, `Summary`); null while no run is live. */
export type View = { name: string; stage: string; counts: number[]; tokens: string } | null;

declare module "claude-code" {
  interface PluginState {
    /** `castle`: the frame of the castle the band draws, an index into run-state.ts's `CASTLE_FRAMES`. */
    sandcastle: { view: View; castle: number };
  }
}
