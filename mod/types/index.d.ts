/** What the band above the prompt draws from (run-state.ts, `Summary`); null while no run is live. */
export type View = { name: string; stage: string; counts: number[]; tokens: string } | null;

declare module "claude-code" {
  interface PluginState {
    sandcastle: { view: View };
  }
}
